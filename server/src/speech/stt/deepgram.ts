/**
 * Deepgram Nova-3 speech recognition, batch mode: the whole recording is sent at once.
 * Fallback for the streaming path (deepgramStream.ts), and the only path for hands-free phrases:
 * measured on short phrases, streaming lost the first word about one time in five
 * ("Stop, Robo" came back as "Robo"), batch did not.
 */
export interface DeepgramConfig { apiKey: string; model: string }

/** Wraps raw 16-bit mono PCM in a WAV header so the batch API can tell what it is. */
export function pcmToWav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** keyterm: a word to listen for (Robo's name), so it is spelled one way. Models or languages that reject it get the request again without it. */
export async function transcribe(cfg: DeepgramConfig, audio: Buffer, mime: string, lang = "en", keyterm?: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const post = (withKeyterm: boolean) => {
    const params = new URLSearchParams({ model: cfg.model, language: lang, smart_format: "true", punctuate: "true" });
    if (withKeyterm && keyterm) params.set("keyterm", keyterm);
    return fetchImpl(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${cfg.apiKey}`, "content-type": mime },
      body: new Uint8Array(audio),
    });
  };
  let res = await post(true);
  if (res.status === 400 && keyterm) res = await post(false);
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
  return j.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
}
