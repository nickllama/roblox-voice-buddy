import { execFile } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { RoboSession } from "./agent/session.js";
import type { Health, UiCommand, UiEvent } from "./agent/events.js";
import { probeStudio } from "./studioProbe.js";
import { type Config, loadConfig, loadPrompt, ROOT, saveConfigPatch, savePrompt } from "./config.js";
import { startHotkey } from "./hotkey.js";
import { phrases } from "./i18n.js";
import { log, recent } from "./log.js";
import type { ParentGate } from "./policy/canUseTool.js";
import { TtsCache } from "./speech/cache.js";
import { transcribe } from "./speech/stt/deepgram.js";
import { DeepgramStream } from "./speech/stt/deepgramStream.js";
import { applyUpdate, checkForUpdate, currentVersion, getStatus, relaunch } from "./update.js";
import { synthesize } from "./speech/tts/elevenlabs.js";
import { ElevenStream, type TtsStreamFactory } from "./speech/tts/elevenlabsStream.js";
import { FishStream, synthesizeFish } from "./speech/tts/fish.js";

let cfg: Config = loadConfig();
const getCfg = () => cfg;
const UI_DIR = path.join(ROOT, "ui");
const ttsCache = new TtsCache(path.join(ROOT, "workspace", "tts-cache"));
const lang = () => cfg.language.split("-")[0];
const P = () => phrases(cfg.language);

// ---------- WebSocket hub ----------
/** stt: a recording from this client's button is in progress (Deepgram stream plus a copy of the chunks for the batch fallback). */
type Client = { ws: WebSocket; parent: boolean; stt?: { stream: DeepgramStream | null; chunks: Buffer[]; mime: string; test: boolean; bytes: number; startedAt: number } };
const clients = new Set<Client>();

function broadcast(e: UiEvent, onlyParents = false) {
  const data = JSON.stringify(e);
  const audio = e.type.startsWith("audio."); // the parent panel does not need audio chunks
  for (const c of clients) {
    if (onlyParents && !c.parent) continue;
    if (audio && c.parent) continue;
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }
}

/** Streaming TTS is on for ElevenLabs and Fish Audio when a key is present. Otherwise speech goes sentence by sentence. */
const ttsStreamFactory: TtsStreamFactory = (h) => {
  if (cfg.tts.provider === "elevenlabs" && cfg.tts.elevenlabs.apiKey) return new ElevenStream(cfg.tts.elevenlabs, lang(), h);
  if (cfg.tts.provider === "fish" && cfg.tts.fish.apiKey) return new FishStream(cfg.tts.fish, lang(), h);
  return null;
};

/** Batch synthesis for the current server-side provider (cached system phrases, streaming fallback). */
function synthesizeServer(text: string): Promise<Buffer> {
  if (cfg.tts.provider === "elevenlabs") return synthesize(cfg.tts.elevenlabs, text, lang());
  if (cfg.tts.provider === "fish") return synthesizeFish(cfg.tts.fish, text, lang());
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

const session = new RoboSession(getCfg, (e) => {
  if (e.type === "notice") log("robo", e.text);
  broadcast(e);
}, gate, ttsStreamFactory);

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
const health: Health = { claude: null, studioLauncher: null, studio: null, studioSession: null, browser: null, sttError: null, sttTest: null, sttProvider: cfg.stt.provider, ttsProvider: cfg.tts.provider, ttsError: null, ttsTest: null };

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
};

function healthSnapshot(): Health {
  return {
    ...health,
    studioLauncher: process.platform === "win32" ? fs.existsSync(cfg.roblox.mcpBat) : null,
    studioSession: session.studio,
    sttProvider: cfg.stt.provider,
    ttsProvider: cfg.tts.provider,
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

// ---------- session timer ----------
let sessionStart = Date.now();
setInterval(() => {
  const minutes = (Date.now() - sessionStart) / 60000;
  if (cfg.session.maxMinutes > 0 && minutes > cfg.session.maxMinutes && session.currentState !== "offline") {
    log("system", "session time is over");
    broadcast({ type: "speak", text: P().sessionOver, id: -1 });
    broadcast({ type: "state", state: "offline" });
    void session.stop();
  }
}, 30000);

// ---------- command handling ----------
async function onCommand(c: Client, cmd: UiCommand) {
  switch (cmd.type) {
    case "ptt.down":
      if (session.isBusy) { await session.interrupt(); }
      broadcast({ type: "state", state: "listen" });
      break;
    case "ptt.up":
      if (!session.isBusy) broadcast({ type: "state", state: session.currentState === "listen" ? "idle" : session.currentState });
      break;
    case "utterance": {
      const text = cmd.text.trim();
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
      if (!session.say(text)) broadcast({ type: "speak", text: P().waitBuilding, id: -1 });
      break;
    }
    case "stop":
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
      if (!session.isBusy) {
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
      const stt: NonNullable<Client["stt"]> = { stream: null, chunks: [], mime: cmd.mime, test: !!cmd.test, bytes: 0, startedAt: Date.now() };
      if (cfg.stt.deepgram.apiKey) {
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
    case "audio.stop": {
      const stt = c.stt;
      c.stt = undefined;
      if (!stt) return;
      let text = "";
      try {
        if (stt.stream) text = await stt.stream.finish();
        if (stt.stream?.failed && stt.chunks.length) text = await transcribe(cfg.stt.deepgram, Buffer.concat(stt.chunks), stt.mime, lang());
      } catch (e) {
        log("error", `Deepgram: ${String(e)}`);
        health.sttError = { code: "deepgram", hint: `Deepgram failed: ${String((e as Error).message ?? e).slice(0, 160)}. Check the key in the panel below.`, at: Date.now() };
        pushHealth();
      }
      const seconds = ((Date.now() - stt.startedAt) / 1000).toFixed(1);
      const level = typeof cmd.level === "number" ? cmd.level : undefined;
      log("system", `recording: ${seconds}s, ${stt.bytes} bytes${level !== undefined ? `, mic peak ${level.toFixed(2)}` : ""}${stt.stream?.audioSeconds != null ? `, Deepgram received ${stt.stream.audioSeconds.toFixed(1)}s` : ""}, text: "${text}"`);
      if (stt.test) {
        health.sttTest = { text, at: Date.now(), bytes: stt.bytes, level, audioSeconds: stt.stream?.audioSeconds ?? null };
        health.sttError = null;
        pushHealth();
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
      sessionStart = Date.now();
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
      c.ws.send(JSON.stringify({ type: "parent.config", config: redact(cfg) }));
      log("parent", `config changed: ${Object.keys(cmd.patch).join(", ")}`);
      if (before.language !== cfg.language) log("parent", "language changed: Claude picks it up after \"New game\"");
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
        const voice = cfg.tts.provider === "fish" ? cfg.tts.fish.referenceId : cfg.tts.elevenlabs.voiceId;
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
