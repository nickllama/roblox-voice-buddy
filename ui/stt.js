/**
 * Speech recognition. Two providers:
 *  - webspeech: the browser's Web Speech API (Edge: Azure, Chrome: Google).
 *  - record:    MediaRecorder in 250 ms chunks sent to the server right away (Deepgram streaming).
 */
export function createStt({ provider, lang, onText, onError, onRecordStart, onRecordChunk, onRecordStop }) {
  if (provider === "webspeech") return webSpeech({ lang, onText, onError });
  return recorder({ onRecordStart, onRecordChunk, onRecordStop, onError });
}

function webSpeech({ lang, onText, onError }) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) { onError("unsupported"); return { start() {}, stop() {}, abort() {} }; }
  let rec = null;
  let finalText = "";
  let active = false;
  function make() {
    const r = new Ctor();
    r.lang = lang;
    r.continuous = true;      // we stop it ourselves when the button is released
    r.interimResults = true;
    r.maxAlternatives = 3;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t + " "; else interim += t;
      }
      onText(finalText + interim, false);
    };
    let failed = false;
    r.onerror = (e) => {
      if (e.error === "aborted" || e.error === "no-speech") return;
      // network, not-allowed, language-not-supported: retrying while the button is held only loops the error.
      failed = true;
      active = false;
      onError(e.error);
    };
    r.onend = () => {
      if (active) { try { r.start(); } catch {} return; } // the browser closed the session itself; keep going while the button is held
      if (!failed) onText(finalText.trim(), true);
    };
    return r;
  }
  return {
    start() { finalText = ""; active = true; rec = make(); try { rec.start(); } catch (e) { onError(String(e)); } },
    stop() { active = false; try { rec?.stop(); } catch {} },
    abort() { active = false; try { rec?.abort(); } catch {} },
  };
}

function recorder({ onRecordStart, onRecordChunk, onRecordStop, onError }) {
  let mr = null, stream = null, aborted = false;
  return {
    async start() {
      try {
        stream = stream || await navigator.mediaDevices.getUserMedia({ audio: true });
        aborted = false;
        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
        mr = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
        // Chunks go out strictly in order, the last chunk before the stop signal.
        let chain = Promise.resolve();
        mr.ondataavailable = (e) => {
          if (!e.data.size || aborted) return;
          chain = chain.then(async () => onRecordChunk(await e.data.arrayBuffer()));
        };
        mr.onstop = () => { chain.then(() => { if (!aborted) onRecordStop(); }); };
        onRecordStart(mime);
        mr.start(250);
      } catch (e) { onError(String(e)); }
    },
    stop() { try { mr?.stop(); } catch {} },
    abort() { aborted = true; try { mr?.stop(); } catch {} },
  };
}
