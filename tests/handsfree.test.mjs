import { test } from "node:test";
import assert from "node:assert/strict";
import { HandsFree } from "../server/src/handsFree.ts";
import { createSegmenter, FRAME_MS } from "../ui/vad.js";
import { pcmToWav } from "../server/src/speech/stt/deepgram.ts";

test("hands-free: asleep, only the wake phrase is acted on", () => {
  const hf = new HandsFree();
  assert.deepEqual(hf.hear("построй большой дом"), { kind: "ignore", nearMiss: false });
  assert.equal(hf.awake, false);
  assert.deepEqual(hf.hear("Робо, привет!"), { kind: "wake", rest: "" });
  assert.equal(hf.awake, true);
});

test("hands-free: the wake phrase in either order, both languages, with recognition's spellings of the name", () => {
  for (const said of ["Привет, Робо", "робот привет", "Роба, привет.", "Hey Robo", "hello, robo!", "Robo, hi"]) {
    const hf = new HandsFree();
    assert.equal(hf.hear(said).kind, "wake", said);
  }
});

test("hands-free: a command said in the same breath as the wake phrase is kept", () => {
  const hf = new HandsFree();
  assert.deepEqual(hf.hear("Робо, привет! Построй красный дом."), { kind: "wake", rest: "Построй красный дом." });
});

test("hands-free: half of the wake phrase is reported as a near miss and does not wake Robo", () => {
  const hf = new HandsFree();
  assert.deepEqual(hf.hear("привет, как дела"), { kind: "ignore", nearMiss: true });
  assert.deepEqual(hf.hear("робо построй дом"), { kind: "ignore", nearMiss: true });
  assert.deepEqual(hf.hear("привет бабушка, это робо"), { kind: "ignore", nearMiss: true });
  assert.equal(hf.awake, false);
});

test("hands-free: awake, every phrase is a command until the stop phrase", () => {
  const hf = new HandsFree();
  hf.hear("Робо, привет");
  assert.deepEqual(hf.hear("сделай машину синей"), { kind: "command", text: "сделай машину синей" });
  assert.deepEqual(hf.hear("Стоп, Робо!"), { kind: "sleep" });
  assert.equal(hf.awake, false);
  assert.equal(hf.hear("сделай машину синей").kind, "ignore");
});

test("hands-free: the stop words inside a longer sentence are a command, and the stop phrase asleep does nothing", () => {
  const hf = new HandsFree();
  assert.equal(hf.hear("стоп робо").kind, "ignore");
  hf.hear("hey robo");
  assert.equal(hf.hear("Робо, пока не трогай мою машину").kind, "command");
  assert.equal(hf.hear("робо сделай знак стоп на дороге").kind, "command");
  assert.equal(hf.awake, true);
  assert.equal(hf.hear("Robo, stop").kind, "sleep");
});

test("hands-free: falls asleep after the quiet time, counted from the last activity", () => {
  let now = 1000;
  const hf = new HandsFree(() => now);
  hf.hear("Робо, привет");
  now += 90_000;
  assert.equal(hf.sleepIfIdle(120_000), false);
  hf.touch(); // Robo finished a reply
  now += 119_000;
  assert.equal(hf.sleepIfIdle(120_000), false);
  now += 2_000;
  assert.equal(hf.sleepIfIdle(120_000), true);
  assert.equal(hf.awake, false);
  assert.equal(hf.sleepIfIdle(120_000), false);
});

test("hands-free: quiet time 0 never puts Robo to sleep", () => {
  let now = 0;
  const hf = new HandsFree(() => now);
  hf.hear("hey robo");
  now += 3_600_000;
  assert.equal(hf.sleepIfIdle(0), false);
  assert.equal(hf.awake, true);
});

// ----- cutting speech out of the open microphone -----
function run(levels, pauseMs = 700) {
  const ev = [];
  let sent = 0;
  const seg = createSegmenter({
    pauseMs: () => pauseMs,
    onStart: () => ev.push("start"),
    onChunk: () => { sent += 1; },
    onStop: () => ev.push("stop"),
    onCancel: () => ev.push("cancel"),
  });
  for (const rms of levels) seg.frame(new ArrayBuffer(2), rms);
  return { ev, sent, seg };
}
const quiet = (n) => Array(n).fill(0.002);
const loud = (n) => Array(n).fill(0.08);

test("vad: silence sends nothing", () => {
  const { ev, sent } = run(quiet(200));
  assert.deepEqual(ev, []);
  assert.equal(sent, 0);
});

test("vad: a phrase is sent with the room sound before it and ends after the pause", () => {
  const { ev, sent } = run([...quiet(20), ...loud(10), ...quiet(7)]);
  assert.deepEqual(ev, ["start", "stop"]);
  // 7 frames of pre-roll (5 quiet + the 2 that started it), 8 more loud ones, 7 quiet ones of the pause
  assert.equal(sent, 7 + 8 + 7);
});

test("vad: a short pause inside a phrase does not end it", () => {
  const { ev } = run([...quiet(10), ...loud(6), ...quiet(4), ...loud(6), ...quiet(7)]);
  assert.deepEqual(ev, ["start", "stop"]);
});

test("vad: a single loud frame does not start a phrase, a short click is cancelled", () => {
  assert.deepEqual(run([...quiet(10), 0.2, ...quiet(20)]).ev, []);
  assert.deepEqual(run([...quiet(10), 0.2, 0.2, ...quiet(20)]).ev, ["start", "cancel"]);
});

test("vad: a sound that never pauses stops opening segments once the room level is learned", () => {
  const tv = Array(30000 / FRAME_MS + 400).fill(0.05);
  const { ev, seg } = run([...quiet(10), ...tv]);
  assert.deepEqual(ev, ["start", "stop"]);
  assert.equal(seg.open, false);
  // speech well above the TV still gets through
  const ev2 = [];
  const s2 = createSegmenter({ pauseMs: () => 700, onStart: () => ev2.push("start"), onChunk() {}, onStop: () => ev2.push("stop"), onCancel: () => ev2.push("cancel") });
  for (const rms of [...quiet(10), ...tv, ...Array(10).fill(0.3), ...Array(8).fill(0.05)]) s2.frame(new ArrayBuffer(2), rms);
  assert.deepEqual(ev2, ["start", "stop", "start", "stop"]);
});

test("vad: reset drops a phrase in progress", () => {
  const { ev, seg } = run([...quiet(10), ...loud(5)]);
  assert.deepEqual(ev, ["start"]);
  assert.equal(seg.reset(), true);
  assert.equal(seg.reset(), false);
});

test("deepgram: raw PCM gets a WAV header for the batch fallback", () => {
  const wav = pcmToWav(Buffer.alloc(3200), 16000);
  assert.equal(wav.length, 44 + 3200);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 3200);
});

test("deepgram: the name is passed as a word to listen for, and dropped when the service rejects it", async () => {
  const { transcribe } = await import("../server/src/speech/stt/deepgram.ts");
  const ok = (text) => new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: text }] }] } }), { status: 200 });
  const urls = [];
  const accepts = async (url) => { urls.push(String(url)); return ok("Робо, привет."); };
  assert.equal(await transcribe({ apiKey: "k", model: "nova-3" }, Buffer.alloc(4), "audio/wav", "ru", "Робо", accepts), "Робо, привет.");
  assert.equal(urls.length, 1);
  assert.match(decodeURIComponent(urls[0]), /keyterm=Робо/);

  urls.length = 0;
  const rejects = async (url) => { urls.push(String(url)); return String(url).includes("keyterm") ? new Response("bad", { status: 400 }) : ok("hey robo"); };
  assert.equal(await transcribe({ apiKey: "k", model: "nova-2" }, Buffer.alloc(4), "audio/wav", "en", "Robo", rejects), "hey robo");
  assert.equal(urls.length, 2);
  assert.doesNotMatch(urls[1], /keyterm/);
});
