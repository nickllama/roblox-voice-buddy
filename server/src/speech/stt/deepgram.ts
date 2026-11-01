/**
 * Deepgram Nova-3 speech recognition, batch mode.
 * Fallback for the streaming path (deepgramStream.ts): the whole recording is sent at once.
 */
export interface DeepgramConfig { apiKey: string; model: string }

export async function transcribe(cfg: DeepgramConfig, audio: Buffer, mime: string, lang = "en"): Promise<string> {
  const params = new URLSearchParams({ model: cfg.model, language: lang, smart_format: "true", punctuate: "true" });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${cfg.apiKey}`, "content-type": mime },
    body: new Uint8Array(audio),
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
  return j.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
}
