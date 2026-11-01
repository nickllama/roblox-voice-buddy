/**
 * ElevenLabs TTS, batch mode: the server returns a finished MP3, the page plays it in <audio>.
 * Used for short system phrases (cached) and as the fallback when the streaming path fails.
 * Streaming lives in elevenlabsStream.ts.
 */
export interface ElevenConfig { apiKey: string; voiceId: string; model: string }

export async function synthesize(cfg: ElevenConfig, text: string, lang = "en"): Promise<Buffer> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}?output_format=mp3_44100_64`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": cfg.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: cfg.model,
      language_code: lang,
      voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 0.95 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
