/**
 * Озвучка. Провайдеры:
 *  - edge:       speechSynthesis с нейронным голосом Edge «Online (Natural)».
 *  - elevenlabs: сервер отдаёт MP3 через POST /api/tts, играем в <audio>.
 * Очередь по предложениям, прерывание по cancel().
 */
export function createTts({ provider, voiceMatch, lang, audioEl, onStart, onEnd }) {
  const queue = [];
  let playing = false;
  let voice = null;

  function pickVoice() {
    const voices = speechSynthesis.getVoices().filter((v) => v && v.name && v.lang);
    const re = new RegExp(voiceMatch, "i");
    voice = voices.find((v) => re.test(v.name)) || voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase())) || null;
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
      // защита от зависшего onend
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
    get voiceName() { return voice?.name ?? "(системный)"; },
  };
}
