/**
 * Озвучка через ElevenLabs. Сервер отдаёт готовый MP3, страница играет через <audio>.
 * Потоковый WebSocket-вариант можно добавить позже, для фраз в одно предложение хватает REST.
 */
export interface ElevenConfig { apiKey: string; voiceId: string; model: string }

export async function synthesize(cfg: ElevenConfig, text: string, lang = "ru"): Promise<Buffer> {
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
