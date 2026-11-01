import WebSocket from "ws";
import type { ElevenConfig } from "./elevenlabs.js";

export interface TtsStreamHandlers {
  /** Кусок MP3 по мере генерации. */
  onAudio: (chunk: Buffer) => void;
  /** Поток закрыт штатно, аудио больше не будет. */
  onEnd: () => void;
  /** Поток сломался. Вызывается один раз, после него onEnd не приходит. */
  onError: (e: Error) => void;
}

/** Общий интерфейс потоковой озвучки, чтобы сессия агента не знала про ElevenLabs. */
export interface TtsStreamer {
  /** Были ли уже отправлены слова. Пустой поток можно закрыть без звука. */
  readonly used: boolean;
  push(text: string): void;
  flush(): void;
  end(): void;
  abort(): void;
}

export type TtsStreamFactory = (h: TtsStreamHandlers) => TtsStreamer | null;

/**
 * Потоковая озвучка ElevenLabs по WebSocket (stream-input).
 * Слова уходят по мере прихода от Claude, в конце предложения flush, аудио приходит кусками
 * и сразу уходит на страницу. Один экземпляр на один текстовый блок ответа.
 * Протокол: первое сообщение {text:" ", voice_settings, generation_config}; дальше {text:"слова "};
 * {text:" ", flush:true} заставляет озвучить накопленное; {text:""} закрывает. Ответы: {audio: base64}, {isFinal:true}.
 */
export class ElevenStream implements TtsStreamer {
  private ws: WebSocket;
  private open = false;
  private pending: string[] = [];
  private done = false;
  used = false;

  constructor(cfg: ElevenConfig, lang: string, private h: TtsStreamHandlers, endpoint = "wss://api.elevenlabs.io") {
    const params = new URLSearchParams({
      model_id: cfg.model,
      output_format: "mp3_44100_64",
      language_code: lang,
      inactivity_timeout: "180", // Claude может думать долго, держим соединение (максимум по документации)
    });
    this.ws = new WebSocket(`${endpoint}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/stream-input?${params}`, {
      headers: { "xi-api-key": cfg.apiKey },
    });
    this.ws.on("open", () => {
      this.ws.send(JSON.stringify({
        text: " ",
        voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 0.95 },
        // Первый звук после ~50 символов, не после 120 по умолчанию: ребёнку важна скорость, не идеальная интонация.
        generation_config: { chunk_length_schedule: [50, 90, 120, 160] },
      }));
      this.open = true;
      for (const m of this.pending.splice(0)) this.ws.send(m);
    });
    this.ws.on("message", (raw) => {
      let j: { audio?: string | null; isFinal?: boolean; error?: string; message?: string; code?: number };
      try { j = JSON.parse(String(raw)); } catch { return; }
      if (j.audio) this.h.onAudio(Buffer.from(j.audio, "base64"));
      if (j.error || j.code) { this.fail(new Error(`ElevenLabs ${j.code ?? ""} ${j.error ?? ""} ${j.message ?? ""}`.trim())); return; }
      if (j.isFinal) this.finish();
    });
    this.ws.on("error", (e) => this.fail(e instanceof Error ? e : new Error(String(e))));
    this.ws.on("close", (code, reason) => {
      if (this.done) return;
      // Закрытие без отправленных слов (например, таймаут простоя, пока Claude строил) не ошибка: просто откроем новый.
      if (code === 1000 || !this.used) this.finish();
      else this.fail(new Error(`ElevenLabs закрыл соединение ${code} ${String(reason)}`.trim()));
    });
  }

  private send(obj: unknown) {
    if (this.done) return;
    const m = JSON.stringify(obj);
    if (this.open) this.ws.send(m); else this.pending.push(m);
  }

  push(text: string) {
    if (!text) return;
    this.used = true;
    this.send({ text: text.endsWith(" ") ? text : text + " " });
  }

  flush() { if (this.used) this.send({ text: " ", flush: true }); }

  end() { this.send({ text: "" }); }

  /** Тихо обрывает поток: без onEnd и onError. */
  abort() {
    this.done = true;
    try { this.ws.terminate(); } catch {}
  }

  private finish() {
    if (this.done) return;
    this.done = true;
    try { this.ws.close(1000); } catch {}
    this.h.onEnd();
  }

  private fail(e: Error) {
    if (this.done) return;
    this.done = true;
    try { this.ws.terminate(); } catch {}
    this.h.onError(e);
  }
}
