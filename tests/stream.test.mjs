/**
 * Streaming speech: word-level text cleaning, assembly of Deepgram responses, and both WebSocket
 * clients against fake servers that mimic the ElevenLabs stream-input and Deepgram listen protocols.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
const { StreamCleaner } = await import("../server/src/speech/streamCleaner.ts");
const { ElevenStream } = await import("../server/src/speech/tts/elevenlabsStream.ts");
const { DeepgramStream, DeepgramTranscript } = await import("../server/src/speech/stt/deepgramStream.ts");

async function fakeServer(onConnection) {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  wss.on("connection", onConnection);
  return { url: `ws://127.0.0.1:${wss.address().port}`, close: () => new Promise((r) => wss.close(r)) };
}

test("StreamCleaner emits whole words, holds the tail, cuts code", () => {
  const c = new StreamCleaner();
  assert.equal(c.push("Done! I ma"), "Done! I ");
  assert.equal(c.push("de the lava"), "made the ");
  assert.equal(c.push("."), "lava. ");
  assert.equal(c.push("Here is code ```lua\nprint(1)\n`"), "Here is code ");
  assert.equal(c.push("``"), "");
  assert.equal(c.push(" and done"), "and ");
  assert.equal(c.flush(), "done ");
});

test("StreamCleaner does not read paths or inline code, in the child's language", () => {
  const en = new StreamCleaner("en");
  assert.equal(en.push("The `game.Workspace.Lava` part became game.Workspace.Red "), "The part became object ");
  const ru = new StreamCleaner("ru-RU");
  assert.equal(ru.push("Объект стал game.Workspace.Red "), "Объект стал объект ");
});

test("DeepgramTranscript accumulates final pieces and replaces the interim one", () => {
  const t = new DeepgramTranscript();
  const r = (transcript, is_final) => ({ type: "Results", is_final, channel: { alternatives: [{ transcript }] } });
  assert.equal(t.feed(r("make", false)), "make");
  assert.equal(t.feed(r("make lava", true)), "make lava");
  assert.equal(t.feed(r("that ki", false)), "make lava that ki");
  assert.equal(t.feed(r("that kills", true)), "make lava that kills");
  assert.equal(t.feed({ type: "Metadata" }), null);
});

test("ElevenStream: init, words, flush, end, audio in chunks", async () => {
  const got = [];
  let headerKey = "";
  const srv = await fakeServer((ws, req) => {
    headerKey = req.headers["xi-api-key"];
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      got.push(m);
      if (m.flush) ws.send(JSON.stringify({ audio: Buffer.from("A").toString("base64") }));
      if (m.text === "") {
        ws.send(JSON.stringify({ audio: Buffer.from("B").toString("base64") }));
        ws.send(JSON.stringify({ isFinal: true, audio: null }));
        ws.close(1000);
      }
    });
  });
  const audio = [];
  let ended = false, failed = null;
  const s = new ElevenStream({ apiKey: "k", voiceId: "v", model: "eleven_flash_v2_5" }, "en", {
    onAudio: (b) => audio.push(b.toString()),
    onEnd: () => { ended = true; },
    onError: (e) => { failed = e; },
  }, srv.url);
  s.push("Done! ");       // before open: must be queued after the init message
  s.flush();
  s.end();
  for (let i = 0; i < 50 && !ended && !failed; i++) await new Promise((r) => setTimeout(r, 20));
  await srv.close();
  assert.equal(failed, null);
  assert.equal(ended, true);
  assert.equal(headerKey, "k");
  assert.equal(got[0].text, " ");
  assert.ok(Array.isArray(got[0].generation_config.chunk_length_schedule));
  assert.deepEqual(got.slice(1).map((m) => m.text), ["Done! ", " ", ""]);
  assert.equal(got[2].flush, true);
  assert.deepEqual(audio, ["A", "B"]);
});

test("ElevenStream: a drop with text is an error, without text just an end", async () => {
  const srv = await fakeServer((ws) => { ws.on("message", (raw) => { if (JSON.parse(String(raw)).text?.trim()) ws.close(1011, "boom"); }); });
  const mk = () => {
    const r = { ended: false, err: null };
    r.s = new ElevenStream({ apiKey: "k", voiceId: "v", model: "m" }, "en", { onAudio() {}, onEnd: () => { r.ended = true; }, onError: (e) => { r.err = e; } }, srv.url);
    return r;
  };
  const a = mk(); a.s.push("word ");
  const b = mk();
  await new Promise((r) => setTimeout(r, 100));
  b.s.abort();
  await srv.close();
  assert.ok(a.err && /1011/.test(a.err.message));
  assert.equal(a.ended, false);
  assert.equal(b.err, null);
});

test("DeepgramStream: binary chunks, Finalize, CloseStream, final text", async () => {
  const seen = { bin: 0, ctl: [], auth: "", url: "" };
  const srv = await fakeServer((ws, req) => {
    seen.auth = req.headers.authorization; seen.url = req.url;
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        seen.bin++;
        ws.send(JSON.stringify({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "make la" }] } }));
        return;
      }
      const m = JSON.parse(String(raw));
      seen.ctl.push(m.type);
      if (m.type === "Finalize") ws.send(JSON.stringify({ type: "Results", is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: "make lava" }] } }));
      if (m.type === "CloseStream") { ws.send(JSON.stringify({ type: "Metadata" })); ws.close(1000); }
    });
  });
  const captions = [];
  const d = new DeepgramStream({ apiKey: "dg", model: "nova-3" }, "en", { onCaption: (t) => captions.push(t), onError: () => {} }, srv.url);
  d.send(Buffer.from([1, 2, 3])); // before open: queued
  await new Promise((r) => setTimeout(r, 50));
  d.send(Buffer.from([4, 5, 6]));
  const text = await d.finish(2000);
  await srv.close();
  assert.equal(text, "make lava");
  assert.equal(seen.bin, 2);
  assert.deepEqual(seen.ctl, ["Finalize", "CloseStream"]);
  assert.equal(seen.auth, "Token dg");
  assert.match(seen.url, /model=nova-3/);
  assert.match(seen.url, /language=en/);
  assert.doesNotMatch(seen.url, /encoding=/);
  assert.ok(captions.includes("make la"));
});

test("DeepgramStream: a server error marks the stream failed, finish returns what it has", async () => {
  const srv = await fakeServer((ws) => { ws.send(JSON.stringify({ type: "Error", description: "bad key" })); });
  let err = null;
  const d = new DeepgramStream({ apiKey: "x", model: "nova-3" }, "en", { onCaption() {}, onError: (e) => { err = e; } }, srv.url);
  await new Promise((r) => setTimeout(r, 100));
  const text = await d.finish(500);
  await srv.close();
  assert.ok(err && /bad key/.test(err.message));
  assert.ok(d.failed);
  assert.equal(text, "");
});
