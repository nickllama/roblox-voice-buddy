/**
 * Hands-free listening: the microphone stays open without the button. Two ways, by the
 * recognition provider:
 *  - webspeech: the browser recognizes continuously; a phrase ends after pauseMs without
 *    new words and goes to the server as text (onPhrase).
 *  - record:    the page cuts speech out of the microphone by loudness (vad.js) and sends
 *    only those pieces to the server as raw PCM (onSegmentStart / onChunk / onSegmentStop).
 *    Silence never leaves the PC.
 * Either way the server decides whether the phrase is for Robo.
 * start() and stop() can be called any number of times; stop() drops a phrase in progress.
 * close() also lets go of the microphone (the mode was turned off).
 */
import { createSegmenter } from "/vad.js";

export function createEar(opts) {
  return opts.provider === "webspeech" ? webSpeechEar(opts) : pcmEar(opts);
}

/** The same error is reported once until something works again, so a dead microphone does not flood the log. */
function onceUntilOk(onError) {
  let last = null;
  return { fail(code) { if (code !== last) { last = code; onError(code); } }, ok() { last = null; } };
}

const FATAL = new Set(["not-allowed", "service-not-allowed", "language-not-supported", "audio-capture"]);

function webSpeechEar({ lang, pauseMs, onSpeech, onInterim, onPhrase, onError }) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const errors = onceUntilOk(onError);
  if (!Ctor) return { start() { errors.fail("unsupported"); }, stop() {}, close() {} };
  let rec = null, active = false;
  let finals = "", interim = "", speaking = false;
  let flushTimer = null, reopenTimer = null;
  let openedAt = 0, quick = 0, flushed = false, fatal = false;

  function flush() {
    const text = (finals + " " + interim).replace(/\s+/g, " ").trim();
    finals = ""; interim = ""; speaking = false;
    if (text) onPhrase(text);
    // A fresh session after every phrase: results that arrive late would repeat the phrase.
    flushed = true;
    try { rec?.abort(); } catch {}
  }

  function open() {
    if (!active) return;
    const r = new Ctor();
    rec = r;
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    openedAt = performance.now();
    flushed = false; fatal = false;
    r.onresult = (e) => {
      if (r !== rec || !active) return;
      errors.ok();
      interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finals += t + " "; else interim += t;
      }
      if (!speaking) { speaking = true; onSpeech(); }
      onInterim((finals + interim).trim());
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, pauseMs());
    };
    r.onerror = (e) => {
      if (r !== rec || e.error === "aborted" || e.error === "no-speech") return;
      fatal = FATAL.has(e.error);
      errors.fail(e.error);
    };
    r.onend = () => {
      if (r !== rec || !active) return;
      // The browser ends a session after a stretch of silence: open the next one.
      // Sessions that die at once (no microphone, no network) are retried more and more slowly.
      const lived = performance.now() - openedAt;
      quick = flushed || lived > 1500 ? 0 : Math.min(quick + 1, 6);
      reopenTimer = setTimeout(open, fatal ? 30000 : quick ? 500 * 2 ** quick : 150);
    };
    try { r.start(); } catch { reopenTimer = setTimeout(open, 2000); }
  }

  function stop() {
    active = false;
    clearTimeout(flushTimer); clearTimeout(reopenTimer);
    finals = ""; interim = ""; speaking = false;
    const r = rec; rec = null;
    try { r?.abort(); } catch {}
  }
  return {
    start() {
      if (active) return;
      active = true; finals = ""; interim = ""; speaking = false; quick = 0;
      open();
    },
    stop,
    close: stop,
  };
}

function pcmEar({ pauseMs, onSpeech, onSegmentStart, onChunk, onSegmentStop, onSegmentCancel, onError }) {
  const errors = onceUntilOk(onError);
  let media = null, actx = null, opening = null, active = false;
  const resume = () => actx?.resume().catch(() => {});

  const seg = createSegmenter({
    pauseMs,
    onStart: () => { errors.ok(); onSegmentStart(actx.sampleRate); onSpeech(); },
    onChunk,
    onStop: onSegmentStop,
    onCancel: onSegmentCancel,
  });

  async function open() {
    media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    // The microphone went away (unplugged, sleep): open it again, or wait for the next start.
    for (const t of media.getAudioTracks()) t.addEventListener("ended", () => {
      opening = null;
      actx?.close().catch(() => {});
      seg.reset();
      if (active) { active = false; setTimeout(() => api.start(), 1000); }
    });
    // 16 kHz is all speech recognition needs; the browser resamples the microphone for us.
    actx = new AudioContext({ sampleRate: 16000 });
    await actx.audioWorklet.addModule("/pcm-worklet.js");
    const node = new AudioWorkletNode(actx, "pcm-frames");
    node.port.onmessage = (e) => { if (active) seg.frame(e.data.pcm, e.data.rms); };
    actx.createMediaStreamSource(media).connect(node);
    node.connect(actx.destination); // the node outputs silence; the connection only keeps it running
    // Without --autoplay-policy=no-user-gesture-required audio stays suspended until someone clicks the page.
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
    resume();
    setTimeout(() => { if (active && actx && actx.state !== "running") errors.fail("audio-suspended"); }, 1500);
  }

  function stop() {
    active = false;
    if (seg.reset()) onSegmentCancel();
  }

  const api = {
    start() {
      if (active) return;
      active = true;
      seg.reset();
      opening = opening || open().catch((e) => { opening = null; errors.fail(e?.name === "NotAllowedError" ? "not-allowed" : e?.name === "NotFoundError" ? "audio-capture" : String(e)); });
    },
    stop,
    close() {
      stop();
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      const pending = opening;
      opening = null;
      // Let go of the microphone once it has finished opening, so the recording light goes out.
      Promise.resolve(pending).then(() => {
        if (opening) return; // started again meanwhile
        for (const t of media?.getTracks() ?? []) t.stop();
        actx?.close().catch(() => {});
        media = null; actx = null;
      });
    },
  };
  return api;
}
