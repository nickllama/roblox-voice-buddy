import { connect } from "/ws.js";
import { createStt } from "/stt.js";
import { createTts } from "/tts.js";
import { createStreamPlayer } from "/player.js";
import { uiStrings } from "/i18n.js";
import { createEar } from "/handsfree.js";

const body = document.body;
const $ = (s) => document.querySelector(s);
const ptt = $("#ptt"), stopBtn = $("#stop"), status = $("#status"), caption = $("#caption"), studio = $("#studio"), player = $("#player"), streamEl = $("#stream");

let cfg = { stt: "webspeech", tts: "edge", language: "en-US", ttsVoiceMatch: "Online \\(Natural\\)" };
let T = uiStrings(cfg.language);
let stt = null, tts = null;
let state = "offline";
let holding = false;
let sttFailed = false; // recognition failed while the button was held: no utterance will follow
let sttTest = false;   // recognition test started from the parent panel: the result goes to the panel, not to Claude
let studioConnected = false;
let breakUntil = null;   // epoch ms while on a break (null with no end: the parent continues)
let breakTimer = null;
// Hands-free mode: the microphone stays open; awake = what it hears goes to Robo as commands.
let hf = { on: false, awake: false, pauseMs: 1500 };
let ear = null;        // the open-microphone listener (handsfree.js)
let earOn = false;
let earTimer = null;
let earSpeech = false; // the "listening" face is on because the open microphone hears the child
let serverState = "offline"; // what the server last said Robo is doing; the page returns to it when a phrase finishes playing

// A reconnect means the server restarted (an update): reload so the page runs the new code too.
const ws = connect(onEvent, (reconnected) => { if (reconnected) location.reload(); });

// Streaming TTS: the server sends MP3 chunks while Claude is still talking.
const stream = createStreamPlayer({
  audioEl: streamEl,
  onEnd: () => { if (state === "speak" && !tts?.busy) setState(afterSpeech()); syncEar(); },
});

/** A phrase finished playing: Robo may still be thinking or building, so go back to that, not to "idle". */
function afterSpeech() {
  return serverState === "think" || serverState === "build" ? serverState : "idle";
}

function setState(s) {
  if (state === "break" && s !== "break" && s !== "offline") return; // the break ends only with the break event
  state = s;
  body.dataset.state = s;
  status.textContent = statusText(s);
  ptt.disabled = s === "offline" || s === "break";
  syncEar();
}

function statusText(s) {
  if (s === "break") return breakText();
  if (s === "idle" && hf.on) return hf.awake ? T.hfAwake : T.hfAsleep;
  return T[s] ?? "";
}

/** The open microphone listens while Robo is silent and nobody holds the button. While Robo builds it still hears the stop phrase. */
function wantEar() {
  if (!hf.on || !ear || holding || sttTest || tts?.busy || stream.busy) return false;
  return state === "idle" || state === "listen" || state === "think" || state === "build";
}
function syncEar() {
  if (!wantEar()) {
    clearTimeout(earTimer); earTimer = null;
    if (earOn) { earOn = false; earSpeech = false; ear.stop(); }
    if (!hf.on) ear?.close();
    return;
  }
  if (earOn || earTimer) return;
  // A gap after Robo's own voice: speakers (Bluetooth especially) still play for a moment after the page thinks the audio ended.
  earTimer = setTimeout(() => { earTimer = null; if (wantEar()) { earOn = true; ear.start(); } }, 1000);
}

/** "Resting. Back in 14:59": the status line during a break, refreshed every second. */
function breakText() {
  if (breakUntil === null) return T.breakParent;
  const left = Math.max(0, Math.ceil((breakUntil - Date.now()) / 1000));
  const m = Math.floor(left / 60), s = left % 60;
  return T.breakIn.replace("{t}", `${m}:${String(s).padStart(2, "0")}`);
}

function setBreak(on, until) {
  clearInterval(breakTimer); breakTimer = null;
  if (on) {
    breakUntil = until ?? null;
    if (holding) pressEnd();
    caption.textContent = "";
    setState("break");
    breakTimer = setInterval(() => { if (state === "break") status.textContent = breakText(); }, 1000);
  } else if (state === "break") {
    state = "idle";
    setState("idle");
  }
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
    onStart: (item) => { caption.textContent = item.text; syncEar(); },
    onEnd: () => { if (state === "speak" && !stream.busy) setState(afterSpeech()); syncEar(); },
    // Every failure goes to the server log; the result of a "Test voice" goes to the parent panel.
    onResult: (r, item) => {
      if (!r.ok) ws.send({ type: "tts.error", code: String(r.error), voice: r.voice });
      if (item.test) ws.send({ type: "tts.result", ok: r.ok, voice: r.voice, ms: r.ms, error: r.error });
    },
  });
  stt = createStt({
    provider: cfg.stt === "webspeech" ? "webspeech" : "record",
    lang: cfg.language,
    onText: (text, final) => {
      caption.textContent = text;
      if (!final) return;
      if (sttTest) { sttTest = false; ws.send({ type: "stt.result", text }); setState("idle"); return; }
      ws.send({ type: "utterance", text });
    },
    onError: (code) => { sttFailed = true; if (sttTest) { sttTest = false; setState("idle"); } ws.send({ type: "stt.error", code }); },
    onRecordStart: (mime) => ws.send({ type: "audio.start", mime, test: sttTest }),
    onRecordChunk: (buf) => ws.sendBinary(buf),
    onRecordStop: (level) => { ws.send({ type: "audio.stop", level }); if (sttTest) { sttTest = false; setState("idle"); } },
  });
  if (earOn) { earOn = false; earSpeech = false; }
  ear?.close();
  ear = createEar({
    provider: cfg.stt === "webspeech" ? "webspeech" : "record",
    lang: cfg.language,
    // Asleep, only the short wake phrase matters, so it is picked up fast. Awake, the child gets time to think mid-sentence.
    pauseMs: () => (hf.awake ? hf.pauseMs : 700),
    // What the room says shows on the screen only while Robo is awake and waiting for a command.
    onSpeech: () => { if (hf.awake && state === "idle") { earSpeech = true; caption.textContent = ""; setState("listen"); } },
    onInterim: (text) => { if (earSpeech) caption.textContent = text; },
    onPhrase: (text) => { earSpeech = false; ws.send({ type: "heard", text }); },
    onSegmentStart: (rate) => ws.send({ type: "audio.start", mime: "audio/l16", handsFree: true, rate }),
    onChunk: (buf) => ws.sendBinary(buf),
    onSegmentStop: () => { earSpeech = false; ws.send({ type: "audio.stop" }); },
    onSegmentCancel: () => ws.send({ type: "audio.cancel" }),
    onError: (code) => ws.send({ type: "stt.error", code, handsFree: true }),
  });
  syncEar();
}

/** Self-check once per page load: tells the server what this browser can do for the configured language. */
let diagSent = false;
async function sendDiag() {
  if (diagSent) return;
  diagSent = true;
  const hasSynth = "speechSynthesis" in window;
  let voices = hasSynth ? speechSynthesis.getVoices() : [];
  // Edge fills the list asynchronously; wait for voiceschanged, but not longer than 3 s.
  if (hasSynth && voices.length === 0) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      speechSynthesis.addEventListener("voiceschanged", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    voices = speechSynthesis.getVoices();
  }
  const prefix = cfg.language.slice(0, 2).toLowerCase();
  const ours = voices.filter((v) => v && v.name && v.lang && v.lang.toLowerCase().startsWith(prefix)).map((v) => v.name);
  ws.send({
    type: "diag",
    speechRecognition: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    mediaRecorder: typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices,
    mse: typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg"),
    voices: ours,
    voicesTotal: voices.length,
  });
}

/** A phrase without streamed audio: waits for the stream to finish so the two do not talk over each other. */
function speakQueued(text, id, test = false) {
  const play = () => { tts.speak(text, () => ws.send({ type: "speak.done", id })); markLastTest(test); };
  if (stream.busy) stream.whenIdle(play); else play();
}
// tts.speak takes (text, done); the test flag rides on the queued item so onResult can report it to the panel.
function markLastTest(test) { if (test && tts.lastItem) tts.lastItem.test = true; }

function onEvent(e) {
  switch (e.type) {
    case "config": cfg = { ...cfg, ...e }; applyLanguage(); buildSpeech(); void sendDiag(); break;
    case "state":
      serverState = e.state;
      // While a phrase is still playing, keep the talking face; afterSpeech() picks the state up when it ends.
      if (!holding && !(state === "speak" && (tts?.busy || stream.busy) && (e.state === "think" || e.state === "build"))) setState(e.state);
      break;
    case "caption": caption.textContent = e.text; break;
    case "speak":
      if (state !== "speak" && state !== "listen") setState("speak");
      if (e.voiced) { caption.textContent = e.text; break; } // the audio for this sentence is already coming via audio.*
      speakQueued(e.text, e.id, !!e.test);
      break;
    case "speak.cancel": tts.cancel(); stream.cancel(); break;
    case "audio.begin": stream.begin(e.id); break;
    case "audio.chunk": stream.chunk(e.id, e.dataBase64); syncEar(); break;
    case "audio.end": stream.end(e.id); break;
    case "notice": speakQueued(e.text, -1); break;
    case "studio": studioConnected = e.connected; renderStudio(); break;
    case "break": setBreak(e.on, e.until); break;
    case "handsfree": {
      // A rising tone when Robo starts taking commands, a falling one when it stops.
      if (hf.on && e.on && hf.awake !== e.awake) beep(e.awake ? 990 : 440, 140);
      hf = { on: e.on, awake: e.awake, pauseMs: e.pauseMs };
      body.dataset.hf = e.on ? (e.awake ? "awake" : "asleep") : "off";
      setState(state);
      break;
    }
    case "stt.test":
      // The parent pressed "Test recognition": listen for four seconds and report what was heard.
      if (holding || state === "offline") break;
      sttTest = true;
      caption.textContent = T.sayNow;
      setState("listen");
      beep(880, 80);
      stt.start();
      setTimeout(() => { if (sttTest) stt.stop(); }, 4000);
      break;
    case "ptt.down": pressStart(); break;
    case "ptt.up": pressEnd(); break;
    case "error": console.error(e.text); break;
  }
}

function pressStart() {
  if (holding || state === "offline" || state === "break") return;
  holding = true;
  ptt.classList.add("pressed");
  tts.cancel();
  stream.cancel();
  ws.send({ type: "ptt.down" });
  setState("listen");
  caption.textContent = "";
  sttFailed = false;
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
  setState(sttFailed ? "idle" : "think");
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
