import { connect } from "/ws.js";
import { createStt } from "/stt.js";
import { createTts } from "/tts.js";
import { createStreamPlayer } from "/player.js";
import { uiStrings } from "/i18n.js";

const body = document.body;
const $ = (s) => document.querySelector(s);
const ptt = $("#ptt"), stopBtn = $("#stop"), status = $("#status"), caption = $("#caption"), studio = $("#studio"), player = $("#player"), streamEl = $("#stream");

let cfg = { stt: "webspeech", tts: "edge", language: "en-US", ttsVoiceMatch: "Online \\(Natural\\)" };
let T = uiStrings(cfg.language);
let stt = null, tts = null;
let state = "offline";
let holding = false;
let studioConnected = false;

const ws = connect(onEvent, () => {});

// Streaming TTS: the server sends MP3 chunks while Claude is still talking.
const stream = createStreamPlayer({
  audioEl: streamEl,
  onEnd: () => { if (state === "speak" && !tts?.busy) setState("idle"); },
});

function setState(s) {
  state = s;
  body.dataset.state = s;
  status.textContent = T[s] ?? "";
  ptt.disabled = s === "offline";
}

function applyLanguage() {
  T = uiStrings(cfg.language);
  document.documentElement.lang = cfg.language.slice(0, 2);
  ptt.querySelector(".label").textContent = T.ptt;
  ptt.setAttribute("aria-label", T.ptt);
  stopBtn.textContent = T.stop;
  renderStudio();
  setState(state);
}

function renderStudio() {
  studio.textContent = studioConnected ? T.studioOn : T.studioOff;
  studio.className = "pill " + (studioConnected ? "on" : "off");
}

function buildSpeech() {
  tts?.cancel();
  tts = createTts({
    provider: cfg.tts, voiceMatch: cfg.ttsVoiceMatch, lang: cfg.language, audioEl: player,
    onStart: (item) => { caption.textContent = item.text; },
    onEnd: () => { if (state === "speak" && !stream.busy) setState("idle"); },
  });
  stt = createStt({
    provider: cfg.stt === "webspeech" ? "webspeech" : "record",
    lang: cfg.language,
    onText: (text, final) => { caption.textContent = text; if (final) ws.send({ type: "utterance", text }); },
    onError: (code) => { ws.send({ type: "stt.error", code }); },
    onRecordStart: (mime) => ws.send({ type: "audio.start", mime }),
    onRecordChunk: (buf) => ws.sendBinary(buf),
    onRecordStop: () => ws.send({ type: "audio.stop" }),
  });
}

/** A phrase without streamed audio: waits for the stream to finish so the two do not talk over each other. */
function speakQueued(text, id) {
  const play = () => tts.speak(text, () => ws.send({ type: "speak.done", id }));
  if (stream.busy) stream.whenIdle(play); else play();
}

function onEvent(e) {
  switch (e.type) {
    case "config": cfg = { ...cfg, ...e }; applyLanguage(); buildSpeech(); break;
    case "state": if (!holding) setState(e.state); break;
    case "caption": caption.textContent = e.text; break;
    case "speak":
      if (state !== "speak" && state !== "listen") setState("speak");
      if (e.voiced) { caption.textContent = e.text; break; } // the audio for this sentence is already coming via audio.*
      speakQueued(e.text, e.id);
      break;
    case "speak.cancel": tts.cancel(); stream.cancel(); break;
    case "audio.begin": stream.begin(e.id); break;
    case "audio.chunk": stream.chunk(e.id, e.dataBase64); break;
    case "audio.end": stream.end(e.id); break;
    case "notice": speakQueued(e.text, -1); break;
    case "studio": studioConnected = e.connected; renderStudio(); break;
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
  stream.cancel();
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
stopBtn.addEventListener("click", () => { tts.cancel(); stream.cancel(); ws.send({ type: "stop" }); setState("idle"); });

// A long press in the top right corner opens the parent panel.
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
