import { query, type McpStdioServerConfig, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { type Config, ensureWorkspace, loadNotes, loadPrompt, ROOT } from "../config.js";
import { phrases } from "../i18n.js";
import { log } from "../log.js";
import { buildCanUseTool, buildPreToolUseHooks, type ParentGate } from "../policy/canUseTool.js";
import { allowedTools, disallowedTools } from "../policy/rules.js";
import { StreamCleaner } from "../speech/streamCleaner.js";
import type { TtsStreamer, TtsStreamFactory } from "../speech/tts/elevenlabsStream.js";
import { cleanForSpeech, SentenceSplitter, type RoboState, type UiEvent } from "./events.js";

const SESSION_FILE = "session.json";

/** MCP server config for Studio. ROBO_FAKE_STUDIO=1 substitutes the fake Studio from tools/. */
function studioServer(cfg: Config): McpStdioServerConfig {
  if (process.env.ROBO_FAKE_STUDIO) {
    return { type: "stdio", command: process.execPath, args: [path.join(ROOT, "tools", "fake-studio-mcp.mjs")], env: { ...process.env as Record<string, string> }, alwaysLoad: true };
  }
  return { type: "stdio", command: "cmd.exe", args: ["/c", cfg.roblox.mcpBat], alwaysLoad: true };
}

type Emit = (e: UiEvent) => void;

/** Queue of user messages as an AsyncIterable for the SDK streaming input. */
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
  private studioConnected: boolean | null = null; // null: init has not arrived yet
  private sessionId: string | null = null;
  private buildTimer: NodeJS.Timeout | null = null;
  private thinkTimer: NodeJS.Timeout | null = null;
  // Streaming TTS: one stream per text block of a reply, words go out as they arrive.
  private tts: TtsStreamer | null = null;
  private ttsId = 0;
  private ttsBroken = false; // the stream broke; sentence-by-sentence speech until the end of this reply
  private cleaner = new StreamCleaner();
  private blockType: string | null = null;
  private interrupted = false; // the child pressed the button mid-turn: the resulting error is expected

  constructor(
    private getCfg: () => Config,
    private emit: Emit,
    private gate: ParentGate,
    private ttsFactory: TtsStreamFactory = () => null,
  ) {}

  get isBusy() { return this.busy; }
  get currentState() { return this.state; }
  /** true/false after init, null while unknown. */
  get studio() { return this.studioConnected; }

  private get lang() { return this.getCfg().language; }
  private get p() { return phrases(this.lang); }

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
    const systemAppend = [
      loadPrompt(),
      `\n\n# Language\nThe child speaks ${this.p.languageName} (${cfg.language}). Always talk to the child in that language.\n`,
      "\n\n# What has been built so far (project notes)\n",
      loadNotes(cfg),
    ].join("");
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
      title: "Robo",
    };
    if (cfg.claude.model) opts.model = cfg.claude.model;
    if (resume) opts.resume = resume;
    return opts;
  }

  /** Starts the long-lived session. Resumes the previous one if there is one. */
  async start(fresh = false): Promise<void> {
    await this.stop();
    const cfg = this.getCfg();
    ensureWorkspace(cfg);
    const resume = fresh ? null : this.loadSavedSession();
    if (fresh) { try { fs.unlinkSync(this.sessionFile()); } catch {} }
    this.input = new InputQueue();
    this.q = query({ prompt: this.input, options: this.buildOptions(resume) });
    this.setState("idle");
    log("system", `session started${resume ? ` (resume ${resume})` : ""}`);
    this.loop = this.consume(this.q).catch((e) => {
      log("error", `agent loop crashed: ${String(e)}`);
      this.emit({ type: "error", text: String(e) });
      this.setState("offline");
    });
  }

  async stop(): Promise<void> {
    this.clearTimers();
    this.abortTts();
    this.input?.close();
    this.q?.close();
    this.q = null;
    this.input = null;
    this.busy = false;
    if (this.loop) { await this.loop.catch(() => {}); this.loop = null; }
  }

  /** An utterance from the child or the parent. */
  say(text: string, from: "child" | "parent" = "child"): boolean {
    if (!this.input || !this.q) { this.emit({ type: "error", text: "Robo is not running" }); return false; }
    if (this.busy) return false;
    log(from, text);
    this.busy = true;
    this.splitter = new SentenceSplitter();
    this.ttsBroken = false;
    this.interrupted = false;
    this.openTts(); // open the TTS connection while Claude thinks: first sound comes earlier
    this.setState("think");
    this.thinkTimer = setTimeout(() => {
      if (this.state === "think") this.speak(this.p.thinking);
    }, 4000);
    this.input.push(from === "parent" ? `[Message from the parent] ${text}` : text);
    return true;
  }

  async interrupt(): Promise<void> {
    this.abortTts();
    this.emit({ type: "speak.cancel" });
    if (this.q && this.busy) {
      this.interrupted = true;
      log("system", "interrupted by the button");
      try { await this.q.interrupt(); } catch (e) { log("error", `interrupt: ${String(e)}`); }
    }
  }

  /** voiced: the audio is already streaming, the page only shows the caption. */
  private speak(text: string, voiced = false) {
    const clean = cleanForSpeech(text, this.lang);
    if (!clean) return;
    this.speakId += 1;
    this.emit({ type: "caption", text: clean });
    this.emit(voiced ? { type: "speak", text: clean, id: this.speakId, voiced: true } : { type: "speak", text: clean, id: this.speakId });
  }

  /** Sentences from Claude's stream: with a live TTS stream they are already voiced word by word, otherwise sentence by sentence. */
  private speakSentences(sentences: string[]) {
    for (const s of sentences) this.speak(s, this.tts !== null);
  }

  // ---------- streaming TTS ----------

  private openTts() {
    if (this.tts || this.ttsBroken) return;
    const id = ++this.ttsId;
    let stream: TtsStreamer | null = null;
    stream = this.ttsFactory({
      onAudio: (chunk) => this.emit({ type: "audio.chunk", id, dataBase64: chunk.toString("base64") }),
      onEnd: () => {
        this.emit({ type: "audio.end", id });
        if (this.tts === stream) this.tts = null; // closed on its own (idle); the next text opens a new one
      },
      onError: (e) => {
        log("error", `streaming TTS: ${e.message}; speaking sentence by sentence until the end of this reply`);
        this.ttsBroken = true;
        if (this.tts === stream) this.tts = null;
        this.emit({ type: "audio.end", id });
      },
    });
    if (!stream) return;
    this.tts = stream;
    this.cleaner = new StreamCleaner(this.lang);
    this.emit({ type: "audio.begin", id });
  }

  /** A text block ended: send the tail and close the stream. An unused stream is closed only when forced. */
  private endTts(force = false) {
    const s = this.tts;
    if (!s) return;
    const rest = this.cleaner.flush();
    if (rest) s.push(rest);
    if (s.used) { s.end(); this.tts = null; }
    else if (force) { s.abort(); this.tts = null; this.emit({ type: "audio.end", id: this.ttsId }); }
  }

  private abortTts() {
    if (!this.tts) return;
    this.tts.abort();
    this.tts = null;
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
      if (this.state === "build") this.speak(this.p.stillBuilding);
    }, 15000);
  }

  private async consume(q: Query): Promise<void> {
    for await (const m of q) this.handle(m);
    log("system", "agent stream ended");
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
          log("system", `init: model ${m.model}, key ${m.apiKeySource}, studio ${srv?.status ?? "none"}, version ${m.claude_code_version}`);
          if (m.apiKeySource === "ANTHROPIC_API_KEY") log("system", "billing by API key, not by subscription");
        }
        break;
      }
      case "stream_event": {
        if (m.parent_tool_use_id) break;
        const ev = m.event as { type: string; delta?: { type?: string; text?: string } };
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          if (this.thinkTimer) { clearTimeout(this.thinkTimer); this.thinkTimer = null; }
          if (this.state !== "speak") this.setState("speak");
          this.openTts();
          if (this.tts) {
            const words = this.cleaner.push(ev.delta.text);
            if (words) this.tts.push(words);
          }
          const sentences = this.splitter.push(ev.delta.text);
          this.speakSentences(sentences);
          if (sentences.length && this.tts) this.tts.flush(); // sentence end: voice what is buffered now
        }
        if (ev.type === "content_block_start") {
          const cb = (m.event as { content_block?: { type?: string; name?: string } }).content_block;
          this.blockType = cb?.type ?? null;
          if (cb?.type === "tool_use") {
            this.speakSentences(this.splitter.flush());
            this.endTts();
            this.setState("build");
            this.startBuildHeartbeat();
            this.emit({ type: "tool", name: cb.name ?? "" });
          }
        }
        if (ev.type === "content_block_stop" && this.blockType === "text") {
          this.speakSentences(this.splitter.flush());
          this.endTts();
          this.blockType = null;
        }
        break;
      }
      case "assistant": {
        if (m.parent_tool_use_id) break;
        for (const block of m.message.content) {
          if (block.type === "tool_use") log("tool", `call ${block.name}`);
        }
        break;
      }
      case "result": {
        this.clearTimers();
        this.speakSentences(this.splitter.flush());
        this.endTts(true);
        if (m.subtype === "success") {
          log("robo", m.result);
        } else {
          const sub: string = m.subtype;
          const errs = "errors" in m && Array.isArray(m.errors) ? (m.errors as string[]).join("; ") : sub;
          if (this.interrupted) log("system", `turn stopped after the interrupt (${sub})`);
          else {
            log("error", `result ${sub}: ${errs}`);
            if (sub === "error_max_turns") this.speak(this.p.tired);
            else this.speak(this.p.wentWrong);
          }
        }
        this.busy = false;
        this.setState("idle");
        break;
      }
      case "rate_limit_event": {
        const info = m.rate_limit_info;
        log("system", `rate limit: ${info.status} ${info.rateLimitType ?? ""} ${info.utilization ?? ""}`);
        if (info.status === "rejected") {
          this.speak(this.p.needRest);
          this.emit({ type: "error", text: `Subscription limit reached (${info.rateLimitType ?? ""}), resets ${info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "?"}` });
        }
        break;
      }
      default:
        break;
    }
  }
}
