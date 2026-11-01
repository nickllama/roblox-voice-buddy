/** Fish Audio streaming client against a fake server that speaks the tts/live MessagePack protocol. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { decode, encode } from "@msgpack/msgpack";
const { FishStream } = await import("../server/src/speech/tts/fish.ts");

async function fakeServer(onConnection) {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  wss.on("connection", onConnection);
  return { url: `ws://127.0.0.1:${wss.address().port}`, close: () => new Promise((r) => wss.close(r)) };
}

test("FishStream: start with request, text, flush, stop, audio frames, finish", async () => {
  const got = [];
  let headers = {};
  const srv = await fakeServer((ws, req) => {
    headers = req.headers;
    ws.on("message", (raw) => {
      const m = decode(raw);
      got.push(m);
      if (m.event === "flush") ws.send(encode({ event: "audio", audio: Buffer.from("A") }));
      if (m.event === "stop") {
        ws.send(encode({ event: "audio", audio: Buffer.from("B") }));
        ws.send(encode({ event: "finish", reason: "stop" }));
        ws.close(1000);
      }
    });
  });
  const audio = [];
  let ended = false, failed = null;
  const s = new FishStream({ apiKey: "fk", referenceId: "voice1", model: "s2.1-pro-free" }, "ru", {
    onAudio: (b) => audio.push(b.toString()),
    onEnd: () => { ended = true; },
    onError: (e) => { failed = e; },
  }, srv.url);
  s.push("Привет ");
  s.flush();
  s.end();
  for (let i = 0; i < 50 && !ended && !failed; i++) await new Promise((r) => setTimeout(r, 20));
  await srv.close();
  assert.equal(failed, null);
  assert.equal(ended, true);
  assert.equal(headers.authorization, "Bearer fk");
  assert.equal(headers.model, "s2.1-pro-free");
  assert.deepEqual(got.map((m) => m.event), ["start", "text", "flush", "stop"]);
  assert.equal(got[0].request.text, "");
  assert.equal(got[0].request.reference_id, "voice1");
  assert.equal(got[0].request.format, "mp3");
  assert.equal(got[0].request.language, "ru");
  assert.equal(got[1].text, "Привет ");
  assert.deepEqual(audio, ["A", "B"]);
});

test("FishStream: finish with reason error is reported as an error", async () => {
  const srv = await fakeServer((ws) => {
    ws.on("message", (raw) => { if (decode(raw).event === "text") { ws.send(encode({ event: "finish", reason: "error" })); ws.close(1000); } });
  });
  let err = null, ended = false;
  const s = new FishStream({ apiKey: "k", referenceId: "", model: "s2.1-pro-free" }, "en", { onAudio() {}, onEnd: () => { ended = true; }, onError: (e) => { err = e; } }, srv.url);
  s.push("word ");
  await new Promise((r) => setTimeout(r, 150));
  await srv.close();
  assert.ok(err && /Fish Audio synthesis failed/.test(err.message));
  assert.equal(ended, false);
});
