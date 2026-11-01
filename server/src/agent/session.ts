import { query, type McpStdioServerConfig, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { type Config, ensureWorkspace, loadNotes, loadPrompt, ROOT } from "../config.js";
import { log } from "../log.js";
import { buildCanUseTool, buildPreToolUseHooks, type ParentGate } from "../policy/canUseTool.js";
import { allowedTools, disallowedTools } from "../policy/rules.js";
import { cleanForSpeech, SentenceSplitter, type RoboState, type UiEvent } from "./events.js";

const SESSION_FILE = "session.json";

/** Конфиг MCP-сервера Studio. ROBO_FAKE_STUDIO=1 подставляет фальшивую Studio из tools/. */
function studioServer(cfg: Config): McpStdioServerConfig {
  if (process.env.ROBO_FAKE_STUDIO) {
    return { type: "stdio", command: process.execPath, args: [path.join(ROOT, "tools", "fake-studio-mcp.mjs")], env: { ...process.env as Record<string, string> }, alwaysLoad: true };
  }
  return { type: "stdio", command: "cmd.exe", args: ["/c", cfg.roblox.mcpBat], alwaysLoad: true };
}

type Emit = (e: UiEvent) => void;

/** Очередь сообщений пользователя как AsyncIterable для потокового ввода SDK. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;
  push(text: string) {
    const msg: SDKUserMessage = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export class RoboSession {
  private q: Query | null = null;
  private input: InputQueue | null = null;
  private loop: Promise<void> | null = null;
  private splitter = new SentenceSplitter();
  private speakId = 0;
  private state: RoboState = "offline";
  private busy = false;
  private studioConnected: boolean | null = null; // null: init ещё не пришёл
  private sessionId: string | null = null;
  private buildTimer: NodeJS.Timeout | null = null;
  private thinkTimer: NodeJS.Timeout | null = null;

  constructor(
    private getCfg: () => Config,
    private emit: Emit,
    private gate: ParentGate,
  ) {}

  get isBusy() { return this.busy; }
  get currentState() { return this.state; }
  /** true/false после init, null пока неизвестно. */
  get studio() { return this.studioConnected; }

  private setState(s: RoboState) {
    if (this.state === s) return;
    this.state = s;
    this.emit({ type: "state", state: s });
  }

  private sessionFile(): string {
    return path.join(this.getCfg().claude.workspace, SESSION_FILE);
  }

  private loadSavedSession(): string | null {
    try {
      const j = JSON.parse(fs.readFileSync(this.sessionFile(), "utf8")) as { session_id?: string };
      return j.session_id ?? null;
    } catch { return null; }
  }

  private saveSession(id: string) {
    this.sessionId = id;
    fs.writeFileSync(this.sessionFile(), JSON.stringify({ session_id: id, saved_at: new Date().toISOString() }));
  }

  private buildOptions(resume: string | null): Options {
    const cfg = this.getCfg();
    const systemAppend = [loadPrompt(), "\n\n# Что уже построено (заметки проекта)\n", loadNotes(cfg)].join("");
    const opts: Options = {
      cwd: cfg.claude.workspace,
      pathToClaudeCodeExecutable: fs.existsSync(cfg.claude.executable) ? cfg.claude.executable : undefined,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "robo/0.1.0" },
      settingSources: [],
      systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend },
      tools: ["Read", "Write"],
      allowedTools: allowedTools(cfg),
      disallowedTools: disallowedTools(cfg),
      permissionMode: "default",
      canUseTool: buildCanUseTool(this.getCfg, this.gate, { onChildNotice: (t) => this.emit({ type: "notice", text: t }) }),
      hooks: { PreToolUse: buildPreToolUseHooks(this.getCfg) },
      mcpServers: { [cfg.roblox.serverName]: studioServer(cfg) },
      strictMcpConfig: true,
      includePartialMessages: true,
      maxTurns: cfg.claude.maxTurns,
      verbatimPrompts: true,
      title: "Робо",
    };
    if (cfg.claude.model) opts.model = cfg.claude.model;
    if (resume) opts.resume = resume;
    return opts;
  }

  /** Запускает долгоживущую сессию. Возобновляет прошлую, если есть. */
  async start(fresh = false): Promise<void> {
    await this.stop();
    const cfg = this.getCfg();
    ensureWorkspace(cfg);
    const resume = fresh ? null : this.loadSavedSession();
    if (fresh) { try { fs.unlinkSync(this.sessionFile()); } catch {} }
    this.input = new InputQueue();
    this.q = query({ prompt: this.input, options: this.buildOptions(resume) });
    this.setState("idle");
    log("system", `сессия запущена${resume ? ` (resume ${resume})` : ""}`);
    this.loop = this.consume(this.q).catch((e) => {
      log("error", `цикл агента упал: ${String(e)}`);
      this.emit({ type: "error", text: String(e) });
      this.setState("offline");
    });
  }

  async stop(): Promise<void> {
    this.clearTimers();
    this.input?.close();
    this.q?.close();
    this.q = null;
    this.input = null;
    this.busy = false;
    if (this.loop) { await this.loop.catch(() => {}); this.loop = null; }
  }

  /** Реплика ребёнка или родителя. */
  say(text: string, from: "child" | "parent" = "child"): boolean {
    if (!this.input || !this.q) { this.emit({ type: "error", text: "Робо не запущен" }); return false; }
    if (this.busy) return false;
    log(from, text);
    this.busy = true;
    this.splitter = new SentenceSplitter();
    this.setState("think");
    this.thinkTimer = setTimeout(() => {
      if (this.state === "think") this.speak("Сейчас подумаю.");
    }, 4000);
    this.input.push(from === "parent" ? `[Сообщение от родителя] ${text}` : text);
    return true;
  }

  async interrupt(): Promise<void> {
    this.emit({ type: "speak.cancel" });
    if (this.q && this.busy) {
      try { await this.q.interrupt(); } catch (e) { log("error", `interrupt: ${String(e)}`); }
    }
  }

  private speak(text: string) {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    this.speakId += 1;
    this.emit({ type: "caption", text: clean });
    this.emit({ type: "speak", text: clean, id: this.speakId });
  }

  private clearTimers() {
    if (this.buildTimer) clearInterval(this.buildTimer);
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    this.buildTimer = null;
    this.thinkTimer = null;
  }

  private startBuildHeartbeat() {
    if (this.buildTimer) return;
    this.buildTimer = setInterval(() => {
      if (this.state === "build") this.speak("Ещё строю.");
    }, 15000);
  }

  private async consume(q: Query): Promise<void> {
    for await (const m of q) this.handle(m);
    log("system", "поток агента завершился");
    this.setState("offline");
  }

  private handle(m: SDKMessage) {
    switch (m.type) {
      case "system": {
        if (m.subtype === "init") {
          this.saveSession(m.session_id);
          const cfg = this.getCfg();
          const srv = m.mcp_servers.find((s) => s.name === cfg.roblox.serverName);
          this.studioConnected = !!srv && srv.status === "connected";
          this.emit({ type: "studio", connected: this.studioConnected === true });
          log("system", `init: модель ${m.model}, ключ ${m.apiKeySource}, studio ${srv?.status ?? "нет"}, версия ${m.claude_code_version}`);
          if (m.apiKeySource === "ANTHROPIC_API_KEY") log("system", "оплата по API-ключу, не по подписке");
        }
        break;
      }
      case "stream_event": {
        if (m.parent_tool_use_id) break;
        const ev = m.event as { type: string; delta?: { type?: string; text?: string } };
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          if (this.thinkTimer) { clearTimeout(this.thinkTimer); this.thinkTimer = null; }
          if (this.state !== "speak") this.setState("speak");
          for (const s of this.splitter.push(ev.delta.text)) this.speak(s);
        }
        if (ev.type === "content_block_start") {
          const cb = (m.event as { content_block?: { type?: string; name?: string } }).content_block;
          if (cb?.type === "tool_use") {
            for (const s of this.splitter.flush()) this.speak(s);
            this.setState("build");
            this.startBuildHeartbeat();
            this.emit({ type: "tool", name: cb.name ?? "" });
          }
        }
        break;
      }
      case "assistant": {
        if (m.parent_tool_use_id) break;
        for (const block of m.message.content) {
          if (block.type === "tool_use") log("tool", `вызов ${block.name}`);
        }
        break;
      }
      case "result": {
        this.clearTimers();
        for (const s of this.splitter.flush()) this.speak(s);
        if (m.subtype === "success") {
          log("robo", m.result);
        } else {
          const sub: string = m.subtype;
          const errs = "errors" in m && Array.isArray(m.errors) ? (m.errors as string[]).join("; ") : sub;
          log("error", `result ${sub}: ${errs}`);
          if (sub === "error_max_turns") this.speak("Я немного устал. Давай попробуем проще.");
          else this.speak("Что-то пошло не так. Попробуй ещё раз.");
        }
        this.busy = false;
        this.setState("idle");
        break;
      }
      case "rate_limit_event": {
        const info = m.rate_limit_info;
        log("system", `лимит: ${info.status} ${info.rateLimitType ?? ""} ${info.utilization ?? ""}`);
        if (info.status === "rejected") {
          this.speak("Мне нужен отдых. Позови маму или папу.");
          this.emit({ type: "error", text: `Лимит подписки исчерпан (${info.rateLimitType ?? ""}), сброс ${info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "?"}` });
        }
        break;
      }
      default:
        break;
    }
  }
}
