import WebSocket from "ws";
import type { DeepgramConfig } from "./deepgram.js";

type Results = {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
};

/** Склеивает ответы Deepgram: окончательные куски копятся, промежуточный заменяется. */
export class DeepgramTranscript {
  private finals: string[] = [];
  private interim = "";

  /** Возвращает текущий текст (окончательное + промежуточное) или null, если сообщение не про текст. */
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
  /** Промежуточный текст для субтитра, пока ребёнок говорит. */
  onCaption: (text: string) => void;
  onError: (e: Error) => void;
}

/**
 * Потоковое распознавание Deepgram по WebSocket.
 * Страница шлёт куски webm/opus из MediaRecorder каждые 250 мс, они уходят в Deepgram как есть
 * (контейнерный формат, encoding не указываем). По отпусканию кнопки Finalize + CloseStream,
 * Deepgram досылает остаток и закрывает соединение.
 */
export class DeepgramStream {
  private ws: WebSocket;
  private open = false;
  private pending: Buffer[] = [];
  private transcript = new DeepgramTranscript();
  private closed: Promise<void>;
  failed: Error | null = null;

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
      let j: Results & { type?: string; description?: string; message?: string };
      try { j = JSON.parse(String(raw)); } catch { return; }
      if (j.type === "Error") { this.fail(new Error(`Deepgram: ${j.description ?? j.message ?? "ошибка"}`)); return; }
      const text = this.transcript.feed(j);
      if (text !== null) this.h.onCaption(text);
    });
    this.ws.on("error", (e) => this.fail(e instanceof Error ? e : new Error(String(e))));
    this.closed = new Promise<void>((resolve) => this.ws.on("close", () => resolve()));
  }

  send(chunk: Buffer) {
    if (this.failed) return;
    if (this.open) this.ws.send(chunk); else this.pending.push(chunk);
  }

  /** Кнопка отпущена: просим досчитать и закрыть. Возвращает весь текст; ждёт закрытия не дольше timeoutMs. */
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
    try { this.ws.terminate(); } catch {}
  }

  private fail(e: Error) {
    if (this.failed) return;
    this.failed = e;
    try { this.ws.terminate(); } catch {}
    this.h.onError(e);
  }
}
