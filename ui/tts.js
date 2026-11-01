/**
 * Speech output. Providers:
 *  - edge:       speechSynthesis with an Edge "Online (Natural)" neural voice.
 *  - elevenlabs: the server returns MP3 via POST /api/tts, played in <audio>.
 * A queue of sentences, interrupted with cancel(). Streamed ElevenLabs audio is handled by player.js.
 */
export function createTts({ provider, voiceMatch, lang, audioEl, onStart, onEnd }) {
  const queue = [];
  let playing = false;
  let voice = null;

  function pickVoice() {
    const voices = speechSynthesis.getVoices().filter((v) => v && v.name && v.lang);
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
    try {
      if (provider === "elevenlabs") await playServer(item.text);
      else await playBrowser(item.text);
    } catch (e) {
      console.warn("tts", e);
      if (provider !== "elevenlabs") { try { await playBrowser(item.text); } catch {} }
    }
    playing = false;
    item.done?.();
    next();
  }

  function playBrowser(text) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = lang;
      u.rate = 0.95;
      u.pitch = 1.05;
      let finished = false;
      const finish = () => { if (!finished) { finished = true; resolve(); } };
      u.onend = finish; u.onerror = finish;
      // guard against a hung onend
      setTimeout(finish, Math.min(20000, 2500 + text.length * 90));
      speechSynthesis.speak(u);
    });
  }

  async function playServer(text) {
    const res = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error("tts " + res.status);
    const url = URL.createObjectURL(await res.blob());
    await new Promise((resolve) => {
      audioEl.src = url;
      audioEl.onended = resolve; audioEl.onerror = resolve;
      audioEl.play().catch(resolve);
    });
    URL.revokeObjectURL(url);
  }

  return {
    speak(text, done) { queue.push({ text, done }); next(); },
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
