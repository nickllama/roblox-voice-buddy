import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { RoboSession } from "./agent/session.js";
import type { UiCommand, UiEvent } from "./agent/events.js";
import { type Config, loadConfig, loadPrompt, ROOT, saveConfigPatch, savePrompt } from "./config.js";
import { startHotkey } from "./hotkey.js";
import { log, recent } from "./log.js";
import type { ParentGate } from "./policy/canUseTool.js";
import { TtsCache } from "./speech/cache.js";
import { transcribe } from "./speech/stt/deepgram.js";
import { DeepgramStream } from "./speech/stt/deepgramStream.js";
import { applyUpdate, checkForUpdate, currentVersion, getStatus, relaunch } from "./update.js";
import { synthesize } from "./speech/tts/elevenlabs.js";
import { ElevenStream, type TtsStreamFactory } from "./speech/tts/elevenlabsStream.js";

let cfg: Config = loadConfig();
const getCfg = () => cfg;
const UI_DIR = path.join(ROOT, "ui");
const ttsCache = new TtsCache(path.join(ROOT, "workspace", "tts-cache"));

// ---------- WebSocket-хаб ----------
/** stt: идёт запись с кнопки этого клиента (поток Deepgram плюс копия кусков для запасного пакетного пути). */
type Client = { ws: WebSocket; parent: boolean; stt?: { stream: DeepgramStream | null; chunks: Buffer[]; mime: string } };
const clients = new Set<Client>();

function broadcast(e: UiEvent, onlyParents = false) {
  const data = JSON.stringify(e);
  const audio = e.type.startsWith("audio."); // куски звука панели родителя не нужны
  for (const c of clients) {
    if (onlyParents && !c.parent) continue;
    if (audio && c.parent) continue;
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }
}

const lang = () => cfg.language.split("-")[0];

/** Потоковая озвучка включается, когда выбран ElevenLabs и есть ключ. Иначе озвучка по предложениям. */
const ttsStreamFactory: TtsStreamFactory = (h) =>
  cfg.tts.provider === "elevenlabs" && cfg.tts.elevenlabs.apiKey ? new ElevenStream(cfg.tts.elevenlabs, lang(), h) : null;

// ---------- канал к родителю ----------
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

// ---------- таймер сессии ----------
let sessionStart = Date.now();
setInterval(() => {
  const minutes = (Date.now() - sessionStart) / 60000;
  if (cfg.session.maxMinutes > 0 && minutes > cfg.session.maxMinutes && session.currentState !== "offline") {
    log("system", "время сессии вышло");
    broadcast({ type: "speak", text: "На сегодня хватит. Отличная работа! Пойдём отдыхать.", id: -1 });
    broadcast({ type: "state", state: "offline" });
    void session.stop();
  }
}, 30000);

// ---------- обработка команд ----------
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
        broadcast({ type: "speak", text: "Я не расслышал. Скажи ещё раз.", id: -1 });
        broadcast({ type: "state", state: "idle" });
        return;
      }
      if (session.studio === false) {
        broadcast({ type: "speak", text: "Открой свою игру в Roblox Studio и нажми кнопку ещё раз.", id: -1 });
        broadcast({ type: "state", state: "idle" });
        log("system", "Studio не подключена, реплика отброшена: " + text);
        return;
      }
      if (!session.say(text)) broadcast({ type: "speak", text: "Подожди, я ещё строю.", id: -1 });
      break;
    }
    case "stop":
      await session.interrupt();
      break;
    case "stt.error":
      log("error", `STT в браузере: ${cmd.code}`);
      if ((cmd.code === "language-not-supported" || cmd.code === "network") && cfg.stt.deepgram.apiKey) {
        cfg = saveConfigPatch({ stt: { provider: "deepgram" } });
        broadcast(configEvent());
        log("system", "распознавание переключено на Deepgram");
      }
      break;
    case "audio.start": {
      // План Б: запись с кнопки распознаём на сервере. Поток Deepgram открывается сразу,
      // куски уходят по мере записи; копия кусков остаётся для пакетного запроса, если поток сломается.
      c.stt?.stream?.abort();
      const stt: NonNullable<Client["stt"]> = { stream: null, chunks: [], mime: cmd.mime };
      if (cfg.stt.deepgram.apiKey) {
        stt.stream = new DeepgramStream(cfg.stt.deepgram, lang(), {
          onCaption: (text) => { if (text) broadcast({ type: "caption", text }); },
          onError: (e) => log("error", `Deepgram поток: ${e.message}; распознаю записью целиком`),
        });
      } else {
        log("error", "выбран Deepgram, но ключа в config.json нет");
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
      }
      await onCommand(c, { type: "utterance", text });
      break;
    }
    // ----- родитель -----
    case "parent.auth":
      c.parent = cmd.pin === cfg.parentPin;
      c.ws.send(JSON.stringify({ type: "parent.auth", ok: c.parent }));
      if (c.parent) {
        c.ws.send(JSON.stringify({ type: "parent.log", entries: recent() }));
        c.ws.send(JSON.stringify(configEvent()));
        c.ws.send(JSON.stringify({ type: "parent.update", status: getStatus() }));
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
      if (!session.say(cmd.text, "parent")) c.ws.send(JSON.stringify({ type: "error", text: "Робо занят" }));
      break;
    case "parent.answer":
      pendingAsks.get(cmd.id)?.(cmd.ok);
      break;
    case "parent.reset":
      sessionStart = Date.now();
      await session.start(true);
      broadcast({ type: "speak", text: "Начинаем новую игру!", id: -1 });
      break;
    case "parent.prompt.get":
      c.ws.send(JSON.stringify({ type: "parent.prompt", text: loadPrompt() }));
      break;
    case "parent.prompt.set":
      savePrompt(cmd.text);
      log("parent", "промпт обновлён, применится после «новая игра»");
      c.ws.send(JSON.stringify({ type: "parent.prompt", text: loadPrompt() }));
      break;
    case "parent.config.get":
      c.ws.send(JSON.stringify({ type: "parent.config", config: redact(cfg) }));
      break;
    case "parent.config.set":
      cfg = saveConfigPatch(cmd.patch);
      scheduleUpdateChecks();
      broadcast(configEvent());
      c.ws.send(JSON.stringify({ type: "parent.config", config: redact(cfg) }));
      log("parent", `конфиг изменён: ${Object.keys(cmd.patch).join(", ")}`);
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

// ---------- обновления ----------
let updateTimer: NodeJS.Timeout | null = null;

async function doUpdate(force: boolean): Promise<void> {
  const st = getStatus();
  if (st.applying) return;
  if (!force && (session.isBusy || session.currentState === "listen")) { log("system", "обновление отложено: Робо занят"); return; }
  broadcast({ type: "parent.update", status: { ...st, applying: true } }, true);
  const changed = await applyUpdate();
  broadcast({ type: "parent.update", status: getStatus() }, true);
  if (!changed) return;
  broadcast({ type: "speak", text: "Секундочку, я обновляюсь.", id: -1 });
  broadcast({ type: "state", state: "offline" });
  await session.stop();
  wss.close();
  server.close(() => relaunch());
  setTimeout(relaunch, 3000); // если close() зависнет на живых соединениях
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
        const key = `${cfg.tts.provider}:${cfg.tts.elevenlabs.voiceId}:${text}`;
        let audio = ttsCache.get(key);
        if (!audio) {
          if (cfg.tts.provider !== "elevenlabs") throw new Error("серверная озвучка выключена");
          audio = await synthesize(cfg.tts.elevenlabs, text, cfg.language.split("-")[0]);
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
  ws.send(JSON.stringify({ type: "studio", connected: session.studio === true } satisfies UiEvent));
  ws.send(JSON.stringify(configEvent()));
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      // Кусок записи с кнопки: в поток Deepgram и в запас.
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.concat(raw as Buffer[]);
      if (c.stt && buf.length) { c.stt.chunks.push(buf); c.stt.stream?.send(buf); }
      return;
    }
    let cmd: UiCommand;
    try { cmd = JSON.parse(String(raw)) as UiCommand; } catch { return; }
    onCommand(c, cmd).catch((e) => log("error", `команда ${cmd.type}: ${String(e)}`));
  });
  ws.on("close", () => { c.stt?.stream?.abort(); clients.delete(c); });
  log("system", `подключение ${req.socket.remoteAddress}`);
});

// ---------- старт ----------
server.listen(cfg.port, cfg.bindHost, async () => {
  log("system", `Робо слушает http://localhost:${cfg.port}  (родитель: /parent), версия ${await currentVersion()}`);
  await session.start();
  scheduleUpdateChecks();
  await startHotkey(cfg.hotkey, (down) => {
    broadcast({ type: "state", state: down ? "listen" : session.currentState });
    // Сама запись идёт в браузере: страница слушает событие ptt через WebSocket.
    for (const c of clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify({ type: down ? "ptt.down" : "ptt.up" }));
  });
});

process.on("SIGINT", async () => { await session.stop(); process.exit(0); });
process.on("SIGTERM", async () => { await session.stop(); process.exit(0); });
