import { decode, encode } from "@msgpack/msgpack";
import WebSocket from "ws";
import type { TtsStreamer, TtsStreamHandlers } from "./elevenlabsStream.js";

/** Fish Audio: s2.1-pro-free is the $0 model with the same quality and languages as s2.1-pro. */
export interface FishConfig { apiKey: string; referenceId: string; model: string }

const API = "https://api.fish.audio";

/** Shared request body for both the HTTP and the WebSocket API. */
function request(cfg: FishConfig, lang: string, text: string) {
  return {
    text,
    reference_id: cfg.referenceId || null,
    format: "mp3",
    mp3_bitrate: 64,
    latency: "balanced",
    chunk_length: 100,          // minimum allowed: first audio sooner, a child cares about speed
    prosody: { speed: 0.95, volume: 0, normalize_loudness: true },
    language: lang || null,    // text normalization only, does not change the voice
    normalize: true,
  };
}

/** Batch TTS over HTTP: used for cached system phrases and as the fallback when streaming fails. */
export async function synthesizeFish(cfg: FishConfig, text: string, lang = "en"): Promise<Buffer> {
  const res = await fetch(`${API}/v1/tts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, model: cfg.model, "content-type": "application/json" },
    body: JSON.stringify(request(cfg, lang, text)),
  });
  if (!res.ok) throw new Error(`Fish Audio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

type FishEvent = { event?: string; audio?: Uint8Array | Buffer; reason?: string; message?: string };

/**
 * Streaming Fish Audio TTS over WebSocket (tts/live). Frames are MessagePack.
 * Protocol: {event:"start", request} first; then {event:"text", text}; {event:"flush"} forces synthesis
 * of what is buffered; {event:"stop"} ends the stream. Server: {event:"audio", audio: bytes},
 * {event:"finish", reason:"stop"|"error"}; unknown events are ignored.
 */
export class FishStream implements TtsStreamer {
  private ws: WebSocket;
  private open = false;
  private pending: Uint8Array[] = [];
  private done = false;
  used = false;

  constructor(cfg: FishConfig, lang: string, private h: TtsStreamHandlers, endpoint = "wss://api.fish.audio") {
    this.ws = new WebSocket(`${endpoint}/v1/tts/live`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, model: cfg.model },
    });
    this.ws.on("open", () => {
      this.ws.send(encode({ event: "start", request: request(cfg, lang, "") }));
      this.open = true;
      for (const m of this.pending.splice(0)) this.ws.send(m);
    });
    this.ws.on("message", (raw) => {
      let ev: FishEvent;
      try { ev = decode(Buffer.isBuffer(raw) ? raw : Buffer.concat(raw as Buffer[])) as FishEvent; } catch { return; }
      if (ev.event === "audio" && ev.audio) this.h.onAudio(Buffer.from(ev.audio));
      else if (ev.event === "finish") {
        if (ev.reason === "error") this.fail(new Error(`Fish Audio synthesis failed${ev.message ? `: ${ev.message}` : ""}`));
        else this.finish();
      }
    });
    this.ws.on("error", (e) => this.fail(e instanceof Error ? e : new Error(String(e))));
    this.ws.on("close", (code, reason) => {
      if (this.done) return;
      if (code === 1000 || !this.used) this.finish();
      else this.fail(new Error(`Fish Audio closed the connection ${code} ${String(reason)}`.trim()));
    });
  }

  private send(obj: unknown) {
    if (this.done) return;
    const m = encode(obj);
    if (this.open) this.ws.send(m); else this.pending.push(m);
  }

  push(text: string) {
    if (!text) return;
    this.used = true;
    this.send({ event: "text", text });
  }

  flush() { if (this.used) this.send({ event: "flush" }); }

  end() { this.send({ event: "stop" }); }

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
