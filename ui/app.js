import { connect } from "/ws.js";
import { createStt } from "/stt.js";
import { createTts } from "/tts.js";

const body = document.body;
const $ = (s) => document.querySelector(s);
const ptt = $("#ptt"), stopBtn = $("#stop"), status = $("#status"), caption = $("#caption"), studio = $("#studio"), player = $("#player");

const STATUS = {
  idle: "Зажми кнопку и говори",
  listen: "Слушаю…",
  think: "Думаю…",
  build: "Строю…",
  speak: "",
  offline: "Робо спит. Позови родителей.",
};

let cfg = { stt: "webspeech", tts: "edge", language: "ru-RU", ttsVoiceMatch: "Online \\(Natural\\).*Russian" };
let stt = null, tts = null;
let state = "offline";
let holding = false;

const ws = connect(onEvent, () => {});

function setState(s) {
  state = s;
  body.dataset.state = s;
  status.textContent = STATUS[s] ?? "";
  ptt.disabled = s === "offline";
}

function buildSpeech() {
  tts?.cancel();
  tts = createTts({
    provider: cfg.tts, voiceMatch: cfg.ttsVoiceMatch, lang: cfg.language, audioEl: player,
    onStart: (item) => { caption.textContent = item.text; },
    onEnd: () => { if (state === "speak") setState("idle"); },
  });
  stt = createStt({
    provider: cfg.stt === "webspeech" ? "webspeech" : "record",
    lang: cfg.language,
    onText: (text, final) => { caption.textContent = text; if (final) ws.send({ type: "utterance", text }); },
    onError: (code) => { ws.send({ type: "stt.error", code }); },
    onAudio: (dataBase64, mime) => ws.send({ type: "audio", dataBase64, mime }),
  });
}

function onEvent(e) {
  switch (e.type) {
    case "config": cfg = { ...cfg, ...e }; buildSpeech(); break;
    case "state": if (!holding) setState(e.state); break;
    case "caption": caption.textContent = e.text; break;
    case "speak":
      if (state !== "speak" && state !== "listen") setState("speak");
      tts.speak(e.text, () => ws.send({ type: "speak.done", id: e.id }));
      break;
    case "speak.cancel": tts.cancel(); break;
    case "notice": tts.speak(e.text); break;
    case "studio":
      studio.textContent = e.connected ? "Roblox Studio подключена" : "Roblox Studio не подключена";
      studio.className = "pill " + (e.connected ? "on" : "off");
      break;
    case "ptt.down": pressStart(); break;
    case "ptt.up": pressEnd(); break;
    case "error": console.error(e.text); break;
  }
}

function pressStart() {
  if (holding || state === "offline") return;
  holding = true;
  ptt.classList.add("pressed");
  tts.cancel();
  ws.send({ type: "ptt.down" });
  setState("listen");
  caption.textContent = "";
  beep(880, 80);
  stt.start();
}
function pressEnd() {
  if (!holding) return;
  holding = false;
  ptt.classList.remove("pressed");
  beep(660, 80);
  stt.stop();
  ws.send({ type: "ptt.up" });
  setState("think");
}

ptt.addEventListener("pointerdown", (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); pressStart(); });
ptt.addEventListener("pointerup", pressEnd);
ptt.addEventListener("pointercancel", pressEnd);
ptt.addEventListener("lostpointercapture", pressEnd);
window.addEventListener("keydown", (e) => { if (e.code === "Space" && !e.repeat) { e.preventDefault(); pressStart(); } });
window.addEventListener("keyup", (e) => { if (e.code === "Space") { e.preventDefault(); pressEnd(); } });
stopBtn.addEventListener("click", () => { tts.cancel(); ws.send({ type: "stop" }); setState("idle"); });

// Долгое нажатие в правом верхнем углу открывает родительский режим.
let hold = null;
$("#parent-hotspot").addEventListener("pointerdown", () => { hold = setTimeout(() => { location.href = "/parent"; }, 2500); });
$("#parent-hotspot").addEventListener("pointerup", () => clearTimeout(hold));
$("#parent-hotspot").addEventListener("pointerleave", () => clearTimeout(hold));

let actx = null;
function beep(freq, ms) {
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; g.gain.value = 0.08;
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + ms / 1000);
  } catch {}
}

setState("offline");
