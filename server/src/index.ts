import { execFile } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { buildRoboServer, ROBO_SERVER } from "./agent/roboTools.js";
import { RoboSession } from "./agent/session.js";
import type { Health, UiCommand, UiEvent } from "./agent/events.js";
import { probeStudio } from "./studioProbe.js";
import { type Config, loadConfig, loadPrompt, ROOT, saveConfigPatch, savePrompt } from "./config.js";
import { HandsFree } from "./handsFree.js";
import { isStopCommand } from "./stopCommand.js";
import { Bedtime, localClock, parseHM, validTimeZone } from "./bedtime.js";
import { type Fact, hasCommand, MathTrainer, parseTables } from "./math.js";
import { startHotkey } from "./hotkey.js";
import { minutes, phrases } from "./i18n.js";
import { log, recent } from "./log.js";
import type { ParentGate } from "./policy/canUseTool.js";
import { TtsCache } from "./speech/cache.js";
import { pcmToWav, transcribe } from "./speech/stt/deepgram.js";
import { DeepgramStream } from "./speech/stt/deepgramStream.js";
import { applyUpdate, checkForUpdate, currentVersion, getStatus, relaunch } from "./update.js";
import { synthesize } from "./speech/tts/elevenlabs.js";
import { ElevenStream, type TtsStreamFactory } from "./speech/tts/elevenlabsStream.js";
import { type FishConfig, FishStream, lookupFishVoice, parseVoiceIds, resolveFishVoice, synthesizeFish } from "./speech/tts/fish.js";
import { DailyStats } from "./stats.js";

let cfg: Config = loadConfig();
const getCfg = () => cfg;
const UI_DIR = path.join(ROOT, "ui");
const ttsCache = new TtsCache(path.join(ROOT, "workspace", "tts-cache"));
const stats = new DailyStats(path.join(cfg.claude.workspace, "stats.json"));
const math = new MathTrainer(path.join(cfg.claude.workspace, "math.json"), Math.max(0, Number(cfg.math?.bonusEvery ?? 5) || 0));
const lang = () => cfg.language.split("-")[0];
const P = () => phrases(cfg.language);

// ---------- WebSocket hub ----------
/**
 * stt: a recording from this client is in progress (Deepgram stream plus a copy of the chunks for the batch fallback).
 * handsFree: the recording is a phrase cut out of the open microphone, not a button press; rate: it is raw PCM at this sample rate.
 */
type Client = { ws: WebSocket; parent: boolean; stt?: { stream: DeepgramStream | null; chunks: Buffer[]; mime: string; test: boolean; bytes: number; startedAt: number; handsFree: boolean; rate?: number } };
const clients = new Set<Client>();

const hf = new HandsFree();

function broadcast(e: UiEvent, onlyParents = false) {
  if (e.type === "speak" || e.type === "notice") hf.said(e.text); // hands-free: Robo's own words heard back are not commands
  const data = JSON.stringify(e);
  const audio = e.type.startsWith("audio."); // the parent panel does not need audio chunks
  for (const c of clients) {
    if (onlyParents && !c.parent) continue;
    if (audio && c.parent) continue;
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }
}

/** Fish Audio settings with the voice resolved: the parent's choice, else the first preset for the child's language. */
const fishCfg = (): FishConfig => ({ ...cfg.tts.fish, referenceId: resolveFishVoice(cfg.tts.fish, lang()) });

/** Streaming TTS is on for ElevenLabs and Fish Audio when a key is present. Otherwise speech goes sentence by sentence. */
const ttsStreamFactory: TtsStreamFactory = (h) => {
  if (cfg.tts.provider === "elevenlabs" && cfg.tts.elevenlabs.apiKey) return new ElevenStream(cfg.tts.elevenlabs, lang(), h);
  if (cfg.tts.provider === "fish" && cfg.tts.fish.apiKey) return new FishStream(fishCfg(), lang(), h);
  return null;
};

/** Batch synthesis for the current server-side provider (cached system phrases, streaming fallback). */
function synthesizeServer(text: string): Promise<Buffer> {
  if (cfg.tts.provider === "elevenlabs") return synthesize(cfg.tts.elevenlabs, text, lang());
  if (cfg.tts.provider === "fish") return synthesizeFish(fishCfg(), text, lang());
  throw new Error("server-side TTS is off");
}

// ---------- channel to the parent ----------
let askId = 0;
const pendingAsks = new Map<number, (ok: boolean) => void>();
const gate: ParentGate = {
  ask(question, timeoutMs) {
    const id = ++askId;
    const parents = [...clients].filter((c) => c.parent);
    if (parents.length === 0) return Promise.resolve(false);
    broadcast({ type: "parent.ask", id, question }, true);
    return new Promise<boolean>((resolve) => {
      const t = setTimeout(() => { pendingAsks.delete(id); resolve(false); }, timeoutMs);
      pendingAsks.set(id, (ok) => { clearTimeout(t); pendingAsks.delete(id); resolve(ok); });
    });
  },
};

/** Alt+P to the Studio window via scripts/publish.ps1. Called from the panel button and from request_publish after the parent's yes. */
function runPublish(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") { reject(new Error("Publishing works only on the Windows PC with Studio")); return; }
    const script = path.join(ROOT, "scripts", "publish.ps1");
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout).trim();
      if (err) reject(new Error(out || err.message)); else resolve(out);
    });
  });
}

// ---------- hands-free mode ----------
// The page keeps the microphone open and sends every phrase it hears; hf (declared next to broadcast) decides whether the phrase is for Robo.
const pauseMs = () => Math.min(4000, Math.max(600, Number(cfg.handsFree.pauseMs) || 1500));
function handsFreeEvent(): UiEvent {
  return { type: "handsfree", on: !!cfg.handsFree.enabled, awake: hf.awake, pauseMs: pauseMs() };
}
function pushHandsFree() { broadcast(handsFreeEvent()); pushHealth(); }

// ---------- multiplication practice ----------
// mathLine: what Robo says when the current reply is done (teach a fact, or ask one).
let mathLine: { line: "teach" | "ask"; fact: Fact } | null = null;
const mathTables = () => parseTables(cfg.math.tables);
const mathOn = () => !!cfg.math.enabled && mathTables().length > 0;
function mathText(kind: "mathTeach" | "mathAsk" | "mathRight" | "mathWrong", f: Fact): string {
  return P()[kind].replace("{a}", String(f.a)).replace("{b}", String(f.b)).replace("{c}", String(f.a * f.b)).replace("{stars}", String(math.stars));
}
function sayMathLine() {
  if (!mathLine) return;
  const m = mathLine;
  mathLine = null;
  broadcast({ type: "speak", text: mathText(m.line === "teach" ? "mathTeach" : "mathAsk", m.fact), id: -1 });
  log("system", `multiplication: ${m.line} ${m.fact.a}x${m.fact.b}`);
}
const MATH_BONUS_NOTE = "The child just earned stars by answering multiplication questions. As the bonus, add one small fun surprise to the game near where the child is building (for example a golden star statue, a little fountain of sparkles or a treasure chest), at most 20 parts, then say in one short sentence that this is the bonus for the stars. Ask nothing.";

const session = new RoboSession(getCfg, (e) => {
  if (e.type === "notice") log("robo", e.text);
  broadcast(e);
  if (e.type === "state" && e.state === "idle") sayMathLine(); // the reply is done: now the multiplication line
  if (e.type === "state" && e.state === "idle") hf.touch(); // the quiet-time countdown starts when Robo finishes, not when the child asked
  if (e.type === "state" && e.state === "idle") stats.syncUsage(session.usage); // a request finished: add it to today's counters
  if (e.type === "studio" || (e.type === "state" && e.state === "idle")) pushHealth(); // init arrived, or a request finished: usage and model changed
}, gate, ttsStreamFactory, {
  [ROBO_SERVER]: buildRoboServer(gate, {
    publish: runPublish,
    notice: (t) => { log("robo", t); broadcast({ type: "notice", text: t }); },
    askParentPhrase: () => P().askParent,
  }),
});

function configEvent(): UiEvent {
  return {
    type: "config",
    stt: cfg.stt.provider,
    tts: cfg.tts.provider,
    hotkey: cfg.hotkey,
    language: cfg.language,
    ttsVoiceMatch: cfg.tts.edge.voiceMatch,
  };
}

// ---------- health for the parent panel ----------
const health: Health = {
  claude: null, studioLauncher: null, studio: null, studioSession: null, browser: null, sttError: null, sttTest: null,
  sttProvider: cfg.stt.provider, ttsProvider: cfg.tts.provider, ttsVoicePinned: true, ttsError: null, ttsTest: null,
  model: null, configuredModel: null, usage: { requests: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, last: null }, rateLimit: null,
  play: { startedAt: null, breakUntil: null, onBreak: false, maxMinutes: cfg.session.maxMinutes, breakMinutes: cfg.session.breakMinutes },
  handsFree: { on: false, awake: false },
  math: null,
  bedtime: null,
  days: [],
};

function ttsHint(code: string, voice: string | null): string {
  if (/no-start|ended-without-start/.test(code)) return `The voice "${voice ?? "?"}" never started. Edge "Online (Natural)" voices need internet; Robo skips a failed voice and tries the next one. If every voice fails, restart the Robo window, or pick ElevenLabs below.`;
  if (/network|synthesis-failed|synthesis-unavailable/.test(code)) return "The neural voice could not be fetched (internet or Microsoft service). Robo tries another voice of the same language; otherwise pick ElevenLabs below.";
  if (/not-allowed|NotAllowedError/.test(code)) return "Audio is blocked in the Robo window until someone clicks in it once. Click the big button once, then test again.";
  if (/unsupported/.test(code)) return "This browser has no speech output. Open Robo in Microsoft Edge.";
  if (/tts 5\d\d|tts 4\d\d/.test(code)) return "The speech service request failed. Check the key, the voice ID and the credit balance below.";
  return "Check the Windows volume and output device, and that the Robo window is not muted.";
}

const STT_HINTS: Record<string, string> = {
  network: "Edge could not reach Microsoft's speech service. Windows Settings -> Privacy & security -> Speech -> turn on \"Online speech recognition\", check the internet connection, or switch recognition to Deepgram below.",
  "language-not-supported": "Edge cannot recognize this language on this PC. Switch recognition to Deepgram below.",
  "not-allowed": "The microphone is blocked for the Robo window. Click the lock icon at the top of the Robo window and allow the microphone.",
  "audio-capture": "No microphone found. Plug one in and start Robo again.",
  unsupported: "This browser has no speech recognition. Open Robo in Microsoft Edge.",
  "no-audio": "The Robo window recorded no sound at all, so Deepgram got nothing to recognize. Robo takes the microphone again on the next press. If it repeats: check that the microphone is plugged in and picked in Windows Settings -> Sound -> Input, then close the Robo window and start it from the desktop shortcut.",
  "audio-suspended": "Hands-free listening waits for one click in the Robo window. Click the window once, or start Robo from the desktop shortcut.",
};

/** Fish Audio with neither a chosen voice nor a preset for the language has no reference voice: the timbre can differ between replies. */
function voicePinned(): boolean {
  return cfg.tts.provider !== "fish" || !!fishCfg().referenceId;
}

function healthSnapshot(): Health {
  return {
    ...health,
    studioLauncher: process.platform === "win32" ? fs.existsSync(cfg.roblox.mcpBat) : null,
    studioSession: session.studio,
    sttProvider: cfg.stt.provider,
    ttsProvider: cfg.tts.provider,
    ttsVoicePinned: voicePinned(),
    model: session.model,
    configuredModel: cfg.claude.model,
    usage: session.usage,
    rateLimit: session.lastRateLimit,
    play: { startedAt: play.startedAt, breakUntil: play.breakUntil, onBreak: play.onBreak, maxMinutes: cfg.session.maxMinutes, breakMinutes: cfg.session.breakMinutes },
    handsFree: { on: !!cfg.handsFree.enabled, awake: hf.awake },
    math: mathOn() ? math.progress(mathTables()) : null,
    bedtime: cfg.bedtime.enabled ? {
      local: localClock(realNow(), cfg.bedtime.timeZone).hm, timeZone: cfg.bedtime.timeZone || "PC time zone",
      warnAt: cfg.bedtime.warnAt, at: cfg.bedtime.at, wakeAt: cfg.bedtime.wakeAt, clockOffsetSec: Math.round(clockOffset / 1000),
      tonight: play.onBreak && play.bedtime ? "sleeping" : null,
    } : null,
    days: stats.recent(14),
  };
}
function pushHealth() { broadcast({ type: "parent.health", health: healthSnapshot() }, true); }

/** `claude auth status` prints JSON; exit code 1 when not signed in, so read stdout from the error too. */
function checkClaudeAuth(): Promise<void> {
  const exe = fs.existsSync(cfg.claude.executable) ? cfg.claude.executable : "claude";
  return new Promise((resolve) => {
    execFile(exe, ["auth", "status"], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      try {
        const j = JSON.parse(String(stdout).replace(/^﻿/, "")) as { loggedIn?: boolean; authMethod?: string };
        health.claude = { loggedIn: !!j.loggedIn, method: String(j.authMethod ?? "") };
      } catch {
        health.claude = { loggedIn: false, method: err ? `cannot run ${exe}` : "unknown" };
      }
      resolve();
    });
  });
}

let studioTimer: NodeJS.Timeout | null = null;
async function refreshStudio(): Promise<void> {
  const r = await probeStudio(cfg);
  const was = health.studio?.connected;
  health.studio = { ...r, at: Date.now() };
  if (was !== r.connected) log("system", `Studio probe: ${r.connected ? "connected" : "not connected"} (${r.detail})`);
  if (session.studio === null) broadcast({ type: "studio", connected: r.connected });
  pushHealth();
}
/** Probe at start, then every minute until Studio shows up (the parent may enable MCP later). */
function scheduleStudioProbe() {
  if (studioTimer) clearInterval(studioTimer);
  studioTimer = setInterval(() => { if (!health.studio?.connected && !session.isBusy) void refreshStudio(); }, 60_000);
}

/** Drops redacted "***" values so saving the panel never overwrites a stored key with asterisks. */
function stripRedacted(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === "***") continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? stripRedacted(v as Record<string, unknown>) : v;
  }
  return out;
}

// ---------- play timer ----------
// The play time counts from the child's first command of a sitting, not from the server start
// (the server often runs for hours before the child sits down). After maxMinutes Robo takes a break:
// the page shows a countdown and the button is off; after breakMinutes (or the parent's Continue)
// a new sitting begins. The Claude session stays alive, so the game is not forgotten.
const play = { startedAt: null as number | null, breakUntil: null as number | null, onBreak: false, bedtime: false };

function breakEvent(): UiEvent {
  return { type: "break", on: play.onBreak, until: play.breakUntil, reason: play.bedtime ? "bedtime" : "play" };
}

// ---------- bedtime ----------
// clockOffset: how far the PC clock is from the real time, from the Date header of an HTTPS answer.
// The child's PC may be set to the wrong zone or drift; bedtime goes by the real time in the family's zone.
let clockOffset = 0;
const realNow = () => Date.now() + clockOffset;
async function syncClock() {
  try {
    const t0 = Date.now();
    const res = await fetch("https://www.google.com/generate_204", { method: "HEAD", signal: AbortSignal.timeout(8000) });
    const date = Date.parse(res.headers.get("date") ?? "");
    if (!Number.isFinite(date)) return;
    const off = date + 500 - (t0 + Date.now()) / 2; // the header has whole seconds: aim at the middle of that second
    const was = clockOffset;
    clockOffset = Math.abs(off) > 60_000 ? off : 0;  // under a minute is not worth correcting
    if (Math.abs(clockOffset - was) > 60_000) log("system", `the PC clock is off by ${Math.round(off / 1000)} s; bedtime uses the corrected time`);
  } catch {}
}
const bedtime = new Bedtime();
let bedDueSince: number | null = null; // bedtime came while Robo was busy: wait a little for the reply to finish

function startBedtime(msUntilWake: number) {
  bedDueSince = null;
  bedtime.markSlept(cfg.bedtime, realNow());
  play.onBreak = true;
  play.bedtime = true;
  play.breakUntil = Date.now() + msUntilWake;
  play.startedAt = null;
  mathLine = null;
  hf.sleep();
  broadcast(handsFreeEvent());
  log("system", `bedtime: good night until ${cfg.bedtime.wakeAt} (${localClock(realNow(), cfg.bedtime.timeZone).hm} local time)`);
  broadcast({ type: "speak", text: P().bedNow, id: -1 });
  broadcast(breakEvent());
  pushHealth();
}

setInterval(() => {
  const ev = bedtime.check(cfg.bedtime, realNow());
  if (!ev) { bedDueSince = null; return; }
  if (ev.kind === "warn") {
    bedtime.markWarned(cfg.bedtime, realNow());
    if (play.onBreak) return;
    log("system", `bedtime: warning, ${ev.minutesLeft} min left`);
    broadcast({ type: "speak", text: P().bedWarn.replace("{min}", minutes(ev.minutesLeft, P())), id: -1 });
    return;
  }
  if (play.onBreak && play.bedtime) return;
  // Let the current reply finish (a half-built thing is sad), but not for longer than five minutes.
  if (session.isBusy) {
    bedDueSince ??= Date.now();
    if (Date.now() - bedDueSince < 5 * 60_000) return;
    void session.interrupt();
  }
  startBedtime(ev.msUntilWake);
}, 10_000);

function startBreak(reason: string) {
  const min = cfg.session.breakMinutes;
  play.onBreak = true;
  play.bedtime = false;
  mathLine = null;
  hf.sleep();
  broadcast(handsFreeEvent());
  stats.breakStarted();
  play.breakUntil = min > 0 ? Date.now() + min * 60_000 : null;
  play.startedAt = null;
  log("system", `break started (${reason}): ${min > 0 ? `${min} min` : "until the parent presses Continue"}`);
  broadcast({ type: "speak", text: min > 0 ? P().breakStart.replace("{min}", minutes(min, P())) : P().sessionOver, id: -1 });
  broadcast(breakEvent());
  pushHealth();
}

function endBreak(reason: string) {
  const wasBedtime = play.bedtime;
  // The parent let the child go on after bedtime: no second good night this night.
  if (wasBedtime && reason !== "time is up") bedtime.allowTonight(cfg.bedtime, realNow());
  play.onBreak = false;
  play.bedtime = false;
  play.breakUntil = null;
  play.startedAt = null;
  log("system", `${wasBedtime ? "bedtime" : "break"} over (${reason})`);
  broadcast(breakEvent());
  // In the morning nobody is there to hear it; after a parent's Continue or a play break, say it.
  if (!(wasBedtime && reason === "time is up")) broadcast({ type: "speak", text: P().breakOver, id: -1 });
  pushHealth();
}

setInterval(() => {
  if (play.onBreak) {
    if (play.breakUntil !== null && Date.now() >= play.breakUntil) endBreak("time is up");
    return;
  }
  if (play.startedAt === null || cfg.session.maxMinutes <= 0) return;
  const minutes = (Date.now() - play.startedAt) / 60_000;
  // Wait for the current reply: a break in the middle of a build would leave the game half done.
  if (minutes >= cfg.session.maxMinutes && !session.isBusy && session.currentState !== "offline") startBreak("play time is up");
}, 5000);

// Hands-free: with no command for sleepAfterMin minutes Robo stops taking phrases as commands.
setInterval(() => {
  if (!cfg.handsFree.enabled || session.isBusy) return;
  if (hf.sleepIfIdle(Number(cfg.handsFree.sleepAfterMin) * 60_000)) {
    log("system", "hands-free: quiet for a while, Robo stopped listening");
    pushHandsFree();
  }
}, 5000);

/** The page showed "listening" for a phrase that led nowhere: put the real state back. */
function settleState() {
  if (!session.isBusy) broadcast({ type: "state", state: session.currentState === "listen" ? "idle" : session.currentState });
}

/**
 * The child said "stop" / "прекрати" / "останови стройку": stop whatever Robo is doing and say so.
 * Pressing the button already interrupts the work, so a stop said with the button finds Robo idle:
 * pressInterruptedAt tells that the press itself stopped a build a moment ago.
 */
let pressInterruptedAt = 0;
async function stopWork(text: string, talking = false) {
  const working = talking || session.isBusy || Date.now() - pressInterruptedAt < 60_000;
  pressInterruptedAt = 0;
  mathLine = null;
  log("child", text);
  if (session.isBusy) await session.interrupt();
  else broadcast({ type: "speak.cancel" }); // Robo may still be talking after its work is done: stop that too
  log("system", working ? "stopped by the child" : "the child said stop, nothing was running");
  broadcast({ type: "speak", text: working ? P().stopBuild : P().nothingToStop, id: -1 });
  broadcast({ type: "state", state: "idle" });
  if (hf.awake) hf.touch();
}

/**
 * A phrase from the open microphone. The wake and stop phrases are handled here; anything else
 * reaches Robo only while it is awake, and is dropped without a trace while it is asleep.
 */
async function onHeard(c: Client, raw: string, duringSpeech = false) {
  const text = raw.trim();
  if (!cfg.handsFree.enabled || play.onBreak || !text) { settleState(); return; }
  // "Stop, Robo" ends the conversation (below). A plain "stop" stops the work and keeps listening;
  // it is taken whether Robo is awake or not, as long as there is something to stop or Robo is awake.
  const sleepPhrase = hf.awake && hf.isSleepPhrase(text);
  if (!sleepPhrase && isStopCommand(text) && (session.isBusy || hf.awake || duringSpeech)) { await stopWork(text, duringSpeech); return; }
  // Said while Robo was talking: anything but a stop may be Robo's own voice coming back.
  if (duringSpeech && !sleepPhrase) { settleState(); return; }
  const a = hf.hear(text);
  switch (a.kind) {
    case "echo":
      log("system", `hands-free: Robo heard itself, dropped: "${text}"`);
      break;
    case "ignore":
      // Only half-matches are logged, so the parent can see why the wake phrase did not work.
      // The rest of what is said in the room is not written anywhere.
      if (a.nearMiss) log("system", `hands-free: not the wake phrase: "${text}"`);
      break;
    case "wake":
      log("system", `hands-free: woke up on "${text}"`);
      pushHandsFree();
      if (session.isBusy) break;
      if (a.rest.split(/\s+/).filter(Boolean).length >= 2) { await onCommand(c, { type: "utterance", text: a.rest, handsFree: true }); return; }
      broadcast({ type: "speak", text: P().handsFreeHello, id: -1 });
      break;
    case "sleep":
      log("system", `hands-free: stopped listening on "${text}"`);
      pushHandsFree();
      mathLine = null;
      if (session.isBusy) await session.interrupt();
      broadcast({ type: "speak", text: P().handsFreeBye, id: -1 });
      break;
    case "command":
      if (!session.isBusy) broadcast({ type: "caption", text: a.text }); // the child sees what Robo understood
      await onCommand(c, { type: "utterance", text: a.text, handsFree: true });
      return;
  }
  settleState();
}

/**
 * The child's phrase while a multiplication question is open. Returns false when it holds no number,
 * so it goes on as an ordinary command. A bare answer is handled here without Claude; an answer with a
 * command in it, or one that earned the bonus, also goes to Claude after the right-or-wrong line.
 */
async function onMathAnswer(text: string): Promise<boolean> {
  const a = math.answer(text, mathTables());
  if (!a) return false;
  if (play.startedAt === null) { play.startedAt = Date.now(); }
  stats.command();
  if (hf.awake) hf.touch();
  log("child", text);
  log("system", `multiplication: ${a.fact.a}x${a.fact.b}, answered ${a.given}, ${a.right ? "right" : "wrong"}, stars ${a.stars}${a.bonus ? ", bonus" : ""}`);
  broadcast({ type: "speak", text: mathText(a.right ? "mathRight" : "mathWrong", a.fact), id: -1 });
  const teachNext = a.right && a.next ? { line: "teach" as const, fact: a.next } : null;
  const command = hasCommand(text) ? text : "";
  if ((command || a.bonus) && session.studio !== false) {
    if (session.say(command, "child", hf.awake, a.bonus ? MATH_BONUS_NOTE : "")) { mathLine = teachNext; pushHealth(); return true; }
  }
  mathLine = teachNext;
  sayMathLine();
  broadcast({ type: "state", state: "idle" });
  pushHealth();
  return true;
}

// ---------- command handling ----------
async function onCommand(c: Client, cmd: UiCommand) {
  switch (cmd.type) {
    case "ptt.down":
      if (play.onBreak) return;
      if (session.isBusy) { mathLine = null; pressInterruptedAt = Date.now(); await session.interrupt(); }
      broadcast({ type: "state", state: "listen" });
      break;
    case "ptt.up":
      if (!session.isBusy) broadcast({ type: "state", state: session.currentState === "listen" ? "idle" : session.currentState });
      break;
    case "utterance": {
      const text = cmd.text.trim();
      if (play.onBreak) { log("system", "on a break, utterance dropped: " + text); return; }
      // "Stop" / "прекрати" / "останови стройку": with the button, or a hands-free phrase that got this far.
      if (isStopCommand(text)) { await stopWork(text); return; }
      if (cmd.handsFree) {
        // From the open microphone: nobody pressed anything, so a stray word or a phrase said
        // while Robo is busy is dropped silently instead of answered with "say it again".
        if (session.isBusy) return;
      }
      // Robo asked a multiplication question: a phrase with a number in it is the answer.
      if (mathOn() && math.expectsAnswer && !session.isBusy && (await onMathAnswer(text))) return;
      if (cmd.handsFree && text.split(/\s+/).length < 2) { settleState(); return; }
      if (play.startedAt === null) { play.startedAt = Date.now(); pushHealth(); }
      stats.command();
      if (hf.awake) hf.touch();
      if (text.split(/\s+/).length < 2) {
        broadcast({ type: "speak", text: P().notHeard, id: -1 });
        broadcast({ type: "state", state: "idle" });
        return;
      }
      if (session.studio === false) {
        broadcast({ type: "speak", text: P().openStudio, id: -1 });
        broadcast({ type: "state", state: "idle" });
        log("system", "Studio not connected, utterance dropped: " + text);
        return;
      }
      // Hands-free: no spoken "let me think": the face shows it, and one more phrase in the room is one more thing to hear back.
      if (!session.say(text, "child", !!cmd.handsFree)) { broadcast({ type: "speak", text: P().waitBuilding, id: -1 }); break; }
      if (mathOn()) { const step = math.afterCommand(mathTables()); mathLine = step.kind === "line" ? step : null; }
      break;
    }
    case "heard":
      await onHeard(c, cmd.text, !!cmd.duringSpeech);
      break;
    case "stop":
      mathLine = null;
      await session.interrupt();
      break;
    case "diag": {
      // Self-check from the page: one summary line plus hints when the chosen providers cannot work.
      const l = lang();
      const neural = cmd.voices.filter((v) => new RegExp(cfg.tts.edge.voiceMatch || ".", "i").test(v));
      health.browser = `speech recognition ${cmd.speechRecognition ? "yes" : "no"}, recorder ${cmd.mediaRecorder ? "yes" : "no"}, streaming audio ${cmd.mse ? "yes" : "no"}, voices for ${l}: ${cmd.voices.length} of ${cmd.voicesTotal}${neural.length ? ` (neural: ${neural.join(", ")})` : ""}`;
      log("system", `browser check: ${health.browser}`);
      pushHealth();
      if (!cmd.speechRecognition && cfg.stt.provider === "webspeech") log("error", "the browser has no speech recognition: open Robo in Microsoft Edge, or put a Deepgram key into config.json and pick Deepgram in the parent panel");
      if (cfg.tts.provider === "edge" && cmd.voices.length === 0) log("error", `no browser voice for ${l}: add the language voice in Windows settings, or put an ElevenLabs key into config.json and pick ElevenLabs in the parent panel`);
      else if (cfg.tts.provider === "edge" && neural.length === 0) log("system", `no neural "Online (Natural)" voice for ${l}; using ${cmd.voices[0]}. Edge neural voices need internet.`);
      if (cfg.stt.provider === "deepgram" && !cmd.mediaRecorder) log("error", "the browser cannot record audio; Deepgram will not work here");
      break;
    }
    case "stt.error": {
      const hint = STT_HINTS[cmd.code] ?? "Unknown recognition error. Try again or switch recognition to Deepgram below.";
      log("error", `browser STT: ${cmd.code}. ${hint}`);
      health.sttError = { code: cmd.code, hint, at: Date.now() };
      if ((cmd.code === "language-not-supported" || cmd.code === "network") && cfg.stt.deepgram.apiKey) {
        cfg = saveConfigPatch({ stt: { provider: "deepgram" } });
        broadcast(configEvent());
        log("system", "speech recognition switched to Deepgram");
      }
      if (cmd.handsFree) settleState(); // the open microphone failed on its own: nothing to answer
      else if (!session.isBusy) {
        broadcast({ type: "speak", text: P().notHeard, id: -1 });
        broadcast({ type: "state", state: "idle" });
      }
      pushHealth();
      break;
    }
    case "tts.error": {
      const hint = ttsHint(cmd.code, cmd.voice);
      log("error", `speech output (${cmd.voice ?? cfg.tts.provider}): ${cmd.code}. ${hint}`);
      health.ttsError = { code: cmd.code, voice: cmd.voice, hint, at: Date.now() };
      pushHealth();
      break;
    }
    case "tts.result":
      health.ttsTest = { ok: cmd.ok, voice: cmd.voice, ms: cmd.ms, error: cmd.error, at: Date.now() };
      if (cmd.ok) health.ttsError = null;
      log("system", `voice test: ${cmd.ok ? "spoke" : "failed"} with ${cmd.voice ?? "?"} in ${cmd.ms} ms${cmd.error ? ` (${cmd.error})` : ""}`);
      pushHealth();
      break;
    case "stt.result":
      // Recognition test from the parent panel: show it, never send it to Claude.
      health.sttTest = { text: cmd.text, at: Date.now() };
      health.sttError = null;
      log("system", `recognition test heard: "${cmd.text}"`);
      pushHealth();
      break;
    case "audio.start": {
      // Plan B: the button recording is recognized on the server. The Deepgram stream opens right away and
      // chunks go out as they are recorded; a copy of the chunks stays for a batch request if the stream breaks.
      c.stt?.stream?.abort();
      const handsFree = !!cmd.handsFree;
      const rate = typeof cmd.rate === "number" && cmd.rate >= 8000 && cmd.rate <= 48000 ? Math.round(cmd.rate) : undefined;
      const stt: NonNullable<Client["stt"]> = { stream: null, chunks: [], mime: cmd.mime, test: !!cmd.test, bytes: 0, startedAt: Date.now(), handsFree, rate };
      if (handsFree) {
        // A phrase from the open microphone is recognized whole at audio.stop (see deepgram.ts for why not as a stream).
      } else if (cfg.stt.deepgram.apiKey) {
        stt.stream = new DeepgramStream(cfg.stt.deepgram, lang(), {
          onCaption: (text) => { if (text) broadcast({ type: "caption", text }); },
          onError: (e) => log("error", `Deepgram stream: ${e.message}; recognizing the whole recording instead`),
        });
      } else {
        log("error", "Deepgram is selected but config.json has no key");
      }
      c.stt = stt;
      break;
    }
    case "audio.cancel":
      c.stt?.stream?.abort();
      c.stt = undefined;
      settleState();
      break;
    case "audio.stop": {
      const stt = c.stt;
      c.stt = undefined;
      if (!stt) return;
      let text = "";
      try {
        if (stt.stream) text = await stt.stream.finish();
        if (stt.handsFree) {
          if (stt.rate && stt.chunks.length && cfg.stt.deepgram.apiKey) text = await transcribe(cfg.stt.deepgram, pcmToWav(Buffer.concat(stt.chunks), stt.rate), "audio/wav", lang(), P().name);
        } else if (stt.chunks.length && (stt.stream?.failed || (!text && stt.stream?.audioSeconds === 0))) {
          // The stream broke, or Deepgram took the stream but heard 0 seconds of it: try the whole recording once more.
          // If the audio itself is broken this fails with Deepgram's own reason, which goes to Health.
          text = await transcribe(cfg.stt.deepgram, Buffer.concat(stt.chunks), stt.mime, lang());
        }
      } catch (e) {
        log("error", `Deepgram: ${String(e)}`);
        health.sttError = { code: "deepgram", hint: `Deepgram failed: ${String((e as Error).message ?? e).slice(0, 160)}. Check the key in the panel below.`, at: Date.now() };
        pushHealth();
      }
      // Hands-free phrases are not logged here: most of them are room talk that is not meant for Robo.
      if (stt.handsFree) { await onHeard(c, text, !!cmd.duringSpeech); break; }
      const seconds = ((Date.now() - stt.startedAt) / 1000).toFixed(1);
      const level = typeof cmd.level === "number" ? cmd.level : undefined;
      log("system", `recording: ${seconds}s, ${stt.bytes} bytes${level !== undefined ? `, mic peak ${level.toFixed(2)}` : ""}${stt.stream?.audioSeconds != null ? `, Deepgram received ${stt.stream.audioSeconds.toFixed(1)}s` : ""}, text: "${text}"`);
      if (stt.test) {
        health.sttTest = { text, at: Date.now(), bytes: stt.bytes, level, audioSeconds: stt.stream?.audioSeconds ?? null };
        health.sttError = null;
        pushHealth();
      } else if (stt.bytes === 0) {
        // The page recorded nothing at all: the microphone is gone, not Deepgram. The page takes a fresh microphone on the next press.
        log("error", "the button recording came with no audio: the microphone stream on the child's PC is broken");
        health.sttError = { code: "no-audio", hint: STT_HINTS["no-audio"], at: Date.now() };
        pushHealth();
        await onCommand(c, { type: "utterance", text: "" });
      } else {
        await onCommand(c, { type: "utterance", text });
      }
      break;
    }
    // ----- parent -----
    case "parent.auth":
      c.parent = cmd.pin === cfg.parentPin;
      c.ws.send(JSON.stringify({ type: "parent.auth", ok: c.parent }));
      if (c.parent) {
        c.ws.send(JSON.stringify({ type: "parent.log", entries: recent() }));
        c.ws.send(JSON.stringify(configEvent()));
        c.ws.send(JSON.stringify({ type: "parent.update", status: getStatus() }));
        c.ws.send(JSON.stringify({ type: "parent.health", health: healthSnapshot() } satisfies UiEvent));
      }
      break;
    default:
      if (!c.parent) return;
      await onParentCommand(c, cmd);
  }
}

async function onParentCommand(c: Client, cmd: UiCommand) {
  switch (cmd.type) {
    case "parent.say":
      if (!session.say(cmd.text, "parent")) c.ws.send(JSON.stringify({ type: "error", text: "Robo is busy" }));
      break;
    case "parent.answer":
      pendingAsks.get(cmd.id)?.(cmd.ok);
      break;
    case "parent.reset":
      play.startedAt = null;
      if (play.onBreak) endBreak("new game");
      await session.start(true);
      broadcast({ type: "speak", text: P().newGame, id: -1 });
      break;
    case "parent.prompt.get":
      c.ws.send(JSON.stringify({ type: "parent.prompt", text: loadPrompt() }));
      break;
    case "parent.prompt.set":
      savePrompt(cmd.text);
      log("parent", "prompt updated, applies after \"New game\"");
      c.ws.send(JSON.stringify({ type: "parent.prompt", text: loadPrompt() }));
      break;
    case "parent.config.get":
      c.ws.send(JSON.stringify({ type: "parent.config", config: redact(cfg) }));
      break;
    case "parent.config.set": {
      const before = cfg;
      cfg = saveConfigPatch(stripRedacted(cmd.patch));
      scheduleUpdateChecks();
      broadcast(configEvent());
      if (!cfg.handsFree.enabled) hf.sleep();
      math.bonusEvery = Math.max(0, Number(cfg.math.bonusEvery) || 0);
      if (cfg.bedtime.enabled) {
        const bad = [!validTimeZone(cfg.bedtime.timeZone) && `time zone "${cfg.bedtime.timeZone}" is unknown (use a name like Europe/Berlin); the PC's zone is used`, parseHM(cfg.bedtime.at) === null && `bedtime "${cfg.bedtime.at}" is not a time like 20:30`].filter(Boolean);
        for (const b of bad) log("error", `bedtime: ${b}`);
        if (bad.length) c.ws.send(JSON.stringify({ type: "error", text: `Bedtime: ${bad.join("; ")}` }));
      }
      broadcast(handsFreeEvent());
      c.ws.send(JSON.stringify({ type: "parent.config", config: redact(cfg) }));
      log("parent", `config changed: ${Object.keys(cmd.patch).join(", ")}`);
      // Model, language, the playtest rule and the saving rule live in the Claude session (model option, system prompt):
      // restart it with resume so the conversation continues.
      if (before.language !== cfg.language || before.claude.model !== cfg.claude.model || before.policy.playtest !== cfg.policy.playtest || !!before.policy.saveProgress !== !!cfg.policy.saveProgress) {
        if (session.isBusy) log("parent", "model/language change applies after the current reply: press \"New game\" or wait for the next idle restart");
        else { await session.start(); log("parent", `session restarted with model ${cfg.claude.model ?? "default"}, language ${cfg.language}`); }
      }
      pushHealth();
      break;
    }
    case "parent.fish.voices.add": {
      const have = new Set((cfg.tts.fish.voices ?? []).map((v) => v.id));
      const ids = parseVoiceIds(cmd.text).filter((id) => !have.has(id));
      const found = await Promise.all(ids.map((id) => lookupFishVoice(id, lang(), cfg.tts.fish.apiKey)));
      const added = found.filter((v) => v !== null);
      const failed = ids.filter((_, i) => found[i] === null);
      if (added.length) cfg = saveConfigPatch({ tts: { fish: { voices: [...(cfg.tts.fish.voices ?? []), ...added] } } });
      log("parent", `Fish Audio voices: added ${added.map((v) => v.name).join(", ") || "none"}${failed.length ? `; not found: ${failed.join(", ")}` : ""}`);
      c.ws.send(JSON.stringify({ type: "parent.fish.result", added: added.map((v) => v.name), failed } satisfies UiEvent));
      c.ws.send(JSON.stringify({ type: "parent.config", config: redact(cfg) }));
      pushHealth();
      break;
    }
    case "parent.fish.voices.remove": {
      const left = (cfg.tts.fish.voices ?? []).filter((v) => v.id !== cmd.id);
      // The removed voice stops being the one in use too; otherwise it would stay chosen with no way to see it in the list.
      const patch = { voices: left, ...(cfg.tts.fish.referenceId === cmd.id ? { referenceId: "" } : {}) };
      cfg = saveConfigPatch({ tts: { fish: patch } });
      log("parent", `Fish Audio voices: removed ${cmd.id}`);
      c.ws.send(JSON.stringify({ type: "parent.config", config: redact(cfg) }));
      pushHealth();
      break;
    }
    case "parent.health.get":
      await checkClaudeAuth();
      await refreshStudio();
      break;
    case "parent.test.tts":
      broadcast({ type: "speak", text: P().voiceTest, id: -1, test: true });
      log("parent", "voice test");
      break;
    case "parent.test.stt":
      if (session.isBusy) { c.ws.send(JSON.stringify({ type: "error", text: "Robo is busy, try again in a moment" })); break; }
      broadcast({ type: "stt.test" });
      log("parent", "recognition test started on the child's page");
      break;
    case "parent.break":
      if (cmd.on && !play.onBreak) startBreak("parent");
      else if (!cmd.on && play.onBreak) endBreak("parent");
      break;
    case "parent.publish":
      try { log("parent", `publish: ${await runPublish()}. First time: finish the dialog in Studio (name, Create).`); }
      catch (e) { const msg = String((e as Error).message ?? e); log("error", `publish: ${msg}`); c.ws.send(JSON.stringify({ type: "error", text: `Publish failed: ${msg}` })); }
      break;
    case "parent.log.get":
      c.ws.send(JSON.stringify({ type: "parent.log", entries: recent() }));
      break;
    case "parent.update.check":
      broadcast({ type: "parent.update", status: await checkForUpdate() }, true);
      break;
    case "parent.update.apply":
      await doUpdate(true);
      break;
    default:
      break;
  }
}

// ---------- updates ----------
let updateTimer: NodeJS.Timeout | null = null;

async function doUpdate(force: boolean): Promise<void> {
  const st = getStatus();
  if (st.applying) return;
  if (!force && (session.isBusy || session.currentState === "listen")) { log("system", "update postponed: Robo is busy"); return; }
  broadcast({ type: "parent.update", status: { ...st, applying: true } }, true);
  const changed = await applyUpdate();
  broadcast({ type: "parent.update", status: getStatus() }, true);
  if (!changed) return;
  broadcast({ type: "speak", text: P().updating, id: -1 });
  broadcast({ type: "state", state: "offline" });
  await session.stop();
  wss.close();
  server.close(() => relaunch());
  setTimeout(relaunch, 3000); // in case close() hangs on live connections
}

function scheduleUpdateChecks() {
  if (updateTimer) clearInterval(updateTimer);
  const min = cfg.update?.checkIntervalMin ?? 0;
  if (min <= 0) return;
  updateTimer = setInterval(async () => {
    const st = await checkForUpdate();
    if (st.available) {
      broadcast({ type: "parent.update", status: st }, true);
      if (cfg.update.auto) await doUpdate(false);
    }
  }, min * 60_000);
}

function redact(c: Config): Config {
  const copy = JSON.parse(JSON.stringify(c)) as Config;
  if (copy.stt.deepgram.apiKey) copy.stt.deepgram.apiKey = "***";
  if (copy.tts.elevenlabs.apiKey) copy.tts.elevenlabs.apiKey = "***";
  if (copy.tts.fish.apiKey) copy.tts.fish.apiKey = "***";
  copy.parentPin = "***";
  return copy;
}

// ---------- HTTP ----------
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".mp3": "audio/mpeg", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/tts" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      try {
        const { text } = JSON.parse(body) as { text: string };
        const voice = cfg.tts.provider === "fish" ? fishCfg().referenceId : cfg.tts.elevenlabs.voiceId;
        const key = `${cfg.tts.provider}:${voice}:${lang()}:${text}`;
        let audio = ttsCache.get(key);
        if (!audio) {
          audio = await synthesizeServer(text);
          ttsCache.put(key, audio);
        }
        res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store" });
        res.end(audio);
      } catch (e) {
        log("error", `TTS: ${String(e)}`);
        res.writeHead(500); res.end(String(e));
      }
    });
    return;
  }
  let file = url.pathname === "/" ? "/index.html" : url.pathname === "/parent" ? "/parent.html" : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(UI_DIR, file);
  if (!full.startsWith(UI_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(full).pipe(res);
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const c: Client = { ws, parent: false };
  clients.add(c);
  ws.send(JSON.stringify({ type: "state", state: session.currentState } satisfies UiEvent));
  ws.send(JSON.stringify({ type: "studio", connected: session.studio ?? health.studio?.connected ?? false } satisfies UiEvent));
  ws.send(JSON.stringify(configEvent()));
  ws.send(JSON.stringify(handsFreeEvent()));
  if (play.onBreak) ws.send(JSON.stringify(breakEvent())); // a reloaded page shows the countdown again
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      // A chunk of the button recording: to the Deepgram stream and to the fallback copy.
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.concat(raw as Buffer[]);
      if (c.stt && buf.length) { c.stt.chunks.push(buf); c.stt.bytes += buf.length; c.stt.stream?.send(buf); }
      return;
    }
    let cmd: UiCommand;
    try { cmd = JSON.parse(String(raw)) as UiCommand; } catch { return; }
    onCommand(c, cmd).catch((e) => log("error", `command ${cmd.type}: ${String(e)}`));
  });
  ws.on("close", () => { c.stt?.stream?.abort(); clients.delete(c); });
  log("system", `connection ${req.socket.remoteAddress}`);
});

// ---------- start ----------
server.listen(cfg.port, cfg.bindHost, async () => {
  log("system", `Robo is listening on http://localhost:${cfg.port}  (parent: /parent), version ${await currentVersion()}`);
  if (process.platform === "win32" && !process.env.ROBO_FAKE_STUDIO && !fs.existsSync(cfg.roblox.mcpBat)) {
    log("error", `Roblox Studio MCP launcher not found: ${cfg.roblox.mcpBat}. Install or update Roblox Studio, then enable "Studio as MCP server" in Assistant -> Manage MCP Servers.`);
  }
  if (!fs.existsSync(cfg.claude.executable) && !process.env.ROBO_FAKE_STUDIO) {
    log("system", `claude executable not at ${cfg.claude.executable}; the SDK will use its bundled one`);
  }
  await session.start();
  scheduleUpdateChecks();
  void syncClock();
  setInterval(() => void syncClock(), 30 * 60_000);
  void checkClaudeAuth().then(() => { if (health.claude && !health.claude.loggedIn) log("error", `Claude is not signed in (${health.claude.method}). On this PC run: claude auth login`); });
  void refreshStudio();
  scheduleStudioProbe();
  await startHotkey(cfg.hotkey, (down) => {
    broadcast({ type: "state", state: down ? "listen" : session.currentState });
    // The recording itself happens in the browser: the page listens for ptt events over WebSocket.
    for (const c of clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify({ type: down ? "ptt.down" : "ptt.up" }));
  });
});

process.on("SIGINT", async () => { await session.stop(); process.exit(0); });
process.on("SIGTERM", async () => { await session.stop(); process.exit(0); });
