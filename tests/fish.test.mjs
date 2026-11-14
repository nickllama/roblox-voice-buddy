/** Fish Audio streaming client against a fake server that speaks the tts/live MessagePack protocol. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { decode, encode } from "@msgpack/msgpack";
const { FishStream, lookupFishVoice, parseVoiceIds, resolveFishVoice } = await import("../server/src/speech/tts/fish.ts");

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

test("resolveFishVoice: the parent's choice wins, else the first preset for the language", () => {
  const voices = [{ id: "ru-1", name: "A", lang: "ru" }, { id: "ru-2", name: "B", lang: "ru" }, { id: "en-1", name: "C", lang: "en" }];
  assert.equal(resolveFishVoice({ referenceId: " custom ", voices }, "ru"), "custom");
  assert.equal(resolveFishVoice({ referenceId: "", voices }, "ru-RU"), "ru-1");
  assert.equal(resolveFishVoice({ referenceId: "", voices }, "en"), "en-1");
  assert.equal(resolveFishVoice({ referenceId: "", voices }, "de"), "");
  assert.equal(resolveFishVoice({ referenceId: "" }, "ru"), "");
});

test("parseVoiceIds: bare IDs, lists and links, without duplicates", () => {
  const a = "4d72cce58e0b479e8aa135d8c1829edd", b = "850F1009B2F54E4483E3A7F3EB558BB4";
  assert.deepEqual(parseVoiceIds(`${a}\n\n${b}, https://fish.audio/m/${a}/ and some words`), [a, b.toLowerCase()]);
  assert.deepEqual(parseVoiceIds("not an id, 12345"), []);
});

test("lookupFishVoice: title and language from Fish Audio, null when it is not there", async () => {
  const id = "4d72cce58e0b479e8aa135d8c1829edd";
  let asked = null;
  const ok = async (url, init) => { asked = { url: String(url), auth: init.headers.Authorization }; return new Response(JSON.stringify({ title: " Robot ", languages: ["ru", "en"] })); };
  assert.deepEqual(await lookupFishVoice(id, "en-US", "key", ok), { id, name: "Robot", lang: "ru" });
  assert.equal(asked.url, `https://api.fish.audio/model/${id}`);
  assert.equal(asked.auth, "Bearer key");
  const bare = async () => new Response(JSON.stringify({ title: "", languages: [] }));
  assert.deepEqual(await lookupFishVoice(id, "de-DE", "", bare), { id, name: "Voice 4d72cc", lang: "de" });
  assert.equal(await lookupFishVoice(id, "en", "", async () => new Response("no", { status: 404 })), null);
  assert.equal(await lookupFishVoice(id, "en", "", async () => { throw new Error("offline"); }), null);
});
