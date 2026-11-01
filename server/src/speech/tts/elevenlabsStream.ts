import WebSocket from "ws";
import type { ElevenConfig } from "./elevenlabs.js";

export interface TtsStreamHandlers {
  /** An MP3 chunk as soon as it is generated. */
  onAudio: (chunk: Buffer) => void;
  /** The stream closed normally; no more audio will come. */
  onEnd: () => void;
  /** The stream broke. Called once; onEnd does not follow. */
  onError: (e: Error) => void;
}

/** Common interface for streaming TTS so the agent session does not know about ElevenLabs. */
export interface TtsStreamer {
  /** Whether any words have been sent. An unused stream can be closed silently. */
  readonly used: boolean;
  push(text: string): void;
  flush(): void;
  end(): void;
  abort(): void;
}

export type TtsStreamFactory = (h: TtsStreamHandlers) => TtsStreamer | null;

/**
 * Streaming ElevenLabs TTS over WebSocket (stream-input).
 * Words go out as they arrive from Claude, a flush at each sentence end, audio comes back in
 * chunks and is forwarded to the page right away. One instance per text block of a reply.
 * Protocol: first message {text:" ", voice_settings, generation_config}; then {text:"words "};
 * {text:" ", flush:true} forces generation of what is buffered; {text:""} closes.
 * Responses: {audio: base64}, {isFinal:true}.
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
      inactivity_timeout: "180", // Claude may think for a while; keep the connection (documented maximum)
    });
    this.ws = new WebSocket(`${endpoint}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/stream-input?${params}`, {
      headers: { "xi-api-key": cfg.apiKey },
    });
    this.ws.on("open", () => {
      this.ws.send(JSON.stringify({
        text: " ",
        voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 0.95 },
        // First audio after ~50 characters instead of the default 120: a child cares about speed, not perfect intonation.
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
      // Closing before any words were sent (for example an idle timeout while Claude was building) is not an error.
      if (code === 1000 || !this.used) this.finish();
      else this.fail(new Error(`ElevenLabs closed the connection ${code} ${String(reason)}`.trim()));
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

  /** Drops the stream silently: no onEnd, no onError. */
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
