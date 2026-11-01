import WebSocket from "ws";
import type { DeepgramConfig } from "./deepgram.js";

type Results = {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
};

/** Assembles Deepgram responses: final pieces accumulate, the interim one is replaced. */
export class DeepgramTranscript {
  private finals: string[] = [];
  private interim = "";

  /** Returns the current text (final + interim), or null when the message is not about text. */
  feed(msg: Results): string | null {
    if (msg.type !== "Results") return null;
    const t = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
    if (msg.is_final) { if (t) this.finals.push(t); this.interim = ""; }
    else this.interim = t;
    return this.text;
  }

  get text(): string {
    return [...this.finals, this.interim].filter(Boolean).join(" ").trim();
  }
}

export interface SttStreamHandlers {
  /** Interim text for the caption while the child is talking. */
  onCaption: (text: string) => void;
  onError: (e: Error) => void;
}

/**
 * Streaming Deepgram speech recognition over WebSocket.
 * The page sends webm/opus chunks from MediaRecorder every 250 ms; they go to Deepgram as is
 * (containerized audio, no encoding parameter). On button release: Finalize + CloseStream,
 * Deepgram sends the remainder and closes the connection.
 */
export class DeepgramStream {
  private ws: WebSocket;
  private open = false;
  private pending: Buffer[] = [];
  private transcript = new DeepgramTranscript();
  private closed: Promise<void>;
  private aborted = false;
  failed: Error | null = null;
  /** From Deepgram's Metadata message: how much audio it actually received. */
  audioSeconds: number | null = null;
  requestId: string | null = null;

  constructor(cfg: DeepgramConfig, lang: string, private h: SttStreamHandlers, endpoint = "wss://api.deepgram.com") {
    const params = new URLSearchParams({
      model: cfg.model,
      language: lang,
      smart_format: "true",
      punctuate: "true",
      interim_results: "true",
    });
    this.ws = new WebSocket(`${endpoint}/v1/listen?${params}`, { headers: { Authorization: `Token ${cfg.apiKey}` } });
    this.ws.on("open", () => {
      this.open = true;
      for (const b of this.pending.splice(0)) this.ws.send(b);
    });
    this.ws.on("message", (raw) => {
      let j: Results & { type?: string; description?: string; message?: string; duration?: number; request_id?: string };
      try { j = JSON.parse(String(raw)); } catch { return; }
      if (j.type === "Error") { this.fail(new Error(`Deepgram: ${j.description ?? j.message ?? "error"}`)); return; }
      if (j.type === "Metadata") { this.audioSeconds = typeof j.duration === "number" ? j.duration : null; this.requestId = j.request_id ?? null; return; }
      const text = this.transcript.feed(j);
      if (text !== null) this.h.onCaption(text);
    });
    // Tearing down a socket that is still connecting raises an error; after abort() that is expected.
    this.ws.on("error", (e) => { if (!this.aborted) this.fail(e instanceof Error ? e : new Error(String(e))); });
    this.closed = new Promise<void>((resolve) => this.ws.on("close", () => resolve()));
  }

  send(chunk: Buffer) {
    if (this.failed) return;
    if (this.open) this.ws.send(chunk); else this.pending.push(chunk);
  }

  /** Button released: ask Deepgram to finish and close. Returns the whole text; waits for close at most timeoutMs. */
  async finish(timeoutMs = 6000): Promise<string> {
    if (!this.failed) {
      try {
        if (!this.open) await new Promise<void>((r) => { this.ws.once("open", () => r()); this.ws.once("close", () => r()); });
        this.ws.send(JSON.stringify({ type: "Finalize" }));
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {}
      await Promise.race([this.closed, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
    }
    this.abort();
    return this.transcript.text;
  }

  abort() {
    this.aborted = true;
    try { this.ws.terminate(); } catch {}
  }

  private fail(e: Error) {
    if (this.failed) return;
    this.failed = e;
    try { this.ws.terminate(); } catch {}
    this.h.onError(e);
  }
}
