/**
 * Speech output. Providers:
 *  - edge:       speechSynthesis with an Edge "Online (Natural)" neural voice.
 *  - elevenlabs, fish: the server returns MP3 via POST /api/tts, played in <audio>.
 * A queue of sentences, interrupted with cancel(). Streamed ElevenLabs audio is handled by player.js.
 * Every utterance reports a result ({ ok, voice, ms, error }) so the parent panel can see why Robo is silent.
 * When a browser voice fails, it is skipped and the next voice of the same language is tried.
 */
export function createTts({ provider, voiceMatch, lang, audioEl, onStart, onEnd, onResult }) {
  const queue = [];
  let playing = false;
  let voice = null;
  const badVoices = new Set();

  function pickVoice() {
    const voices = speechSynthesis.getVoices().filter((v) => v && v.name && v.lang && !badVoices.has(v.name));
    const prefix = lang.slice(0, 2).toLowerCase();
    // Voices of the child's language first; among them the one matching voiceMatch (Edge neural voices by default).
    const ours = voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
    const re = new RegExp(voiceMatch || ".", "i");
    voice = ours.find((v) => re.test(v.name)) || ours[0] || null;
    return voice;
  }
  if ("speechSynthesis" in window) {
    pickVoice();
    speechSynthesis.addEventListener("voiceschanged", pickVoice);
  }

  async function next() {
    if (playing) return;
    const item = queue.shift();
    if (!item) { onEnd?.(); return; }
    playing = true;
    onStart?.(item);
    let result;
    try {
      if (provider !== "edge") result = await playServer(item.text);
      else {
        result = await playBrowser(item.text);
        if (!result.ok && voice) {
          // This voice is broken (neural voices need internet): skip it and try another one of the same language.
          badVoices.add(voice.name);
          const failed = voice.name;
          if (pickVoice()) {
            const retry = await playBrowser(item.text);
            result = { ...retry, error: retry.ok ? `${failed}: ${result.error}; switched to ${voice.name}` : `${failed}: ${result.error}; ${voice.name}: ${retry.error}` };
          }
        }
      }
    } catch (e) {
      console.warn("tts", e);
      result = { ok: false, voice: provider, ms: 0, error: String(e) };
    }
    playing = false;
    onResult?.(result, item);
    item.done?.(result);
    next();
  }

  function playBrowser(text) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve({ ok: false, voice: null, ms: 0, error: "unsupported" });
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = lang;
      u.rate = 0.95;
      u.pitch = 1.05;
      const t0 = performance.now();
      let started = false, finished = false;
      const finish = (ok, error) => {
        if (finished) return;
        finished = true;
        resolve({ ok, voice: voice?.name ?? "(system)", ms: Math.round(performance.now() - t0), error: error ?? null });
      };
      u.onstart = () => { started = true; };
      u.onend = () => finish(started, started ? null : "ended-without-start");
      u.onerror = (e) => finish(false, e.error || "error");
      // guard against a hung engine: no start within 6 s, or no end at all
      setTimeout(() => { if (!started) { try { speechSynthesis.cancel(); } catch {} finish(false, "no-start"); } }, 6000);
      setTimeout(() => finish(started, started ? null : "no-start"), Math.min(30000, 8000 + text.length * 90));
      speechSynthesis.speak(u);
    });
  }

  async function playServer(text) {
    const t0 = performance.now();
    const res = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error("tts " + res.status);
    const url = URL.createObjectURL(await res.blob());
    let error = null;
    await new Promise((resolve) => {
      audioEl.src = url;
      audioEl.onended = resolve;
      audioEl.onerror = () => { error = "audio-error"; resolve(); };
      audioEl.play().catch((e) => { error = e?.name || "play-failed"; resolve(); });
    });
    URL.revokeObjectURL(url);
    return { ok: !error, voice: provider, ms: Math.round(performance.now() - t0), error };
  }

  let lastItem = null;
  return {
    speak(text, done) { lastItem = { text, done }; queue.push(lastItem); next(); },
    /** The most recently queued item; app.js marks it when the phrase is a "Test voice" from the panel. */
    get lastItem() { return lastItem; },
    cancel() {
      queue.length = 0;
      try { speechSynthesis.cancel(); } catch {}
      try { audioEl.pause(); audioEl.src = ""; } catch {}
      playing = false;
    },
    get voiceName() { return voice?.name ?? "(system)"; },
    get busy() { return playing || queue.length > 0; },
  };
}
