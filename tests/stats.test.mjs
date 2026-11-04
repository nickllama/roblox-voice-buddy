import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DailyStats, dayKey } from "../server/src/stats.ts";

const MIN = 60_000;
function make(start) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robo-stats-"));
  const file = path.join(dir, "stats.json");
  let now = start;
  const clock = () => now;
  const stats = new DailyStats(file, clock);
  return { stats, file, tick: (ms) => { now += ms; } };
}
const usage = (requests, tokensIn, tokensOut, turns = requests) => ({ requests, turns, inputTokens: tokensIn, outputTokens: tokensOut, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: requests * 0.01, last: null });

test("stats: short gaps between commands count as play, long gaps do not", () => {
  const t0 = new Date(2026, 10, 4, 15, 0).getTime();
  const { stats, tick } = make(t0);
  stats.command();
  tick(3 * MIN); stats.command();
  tick(5 * MIN); stats.command();
  tick(40 * MIN); stats.command(); // the child was away: not play time
  tick(2 * MIN); stats.command();
  const [day] = stats.recent();
  assert.equal(day.date, dayKey(t0));
  assert.equal(day.commands, 5);
  assert.equal(day.playMs, 10 * MIN);
  assert.equal(day.firstAt, t0);
  assert.equal(day.lastAt, t0 + 50 * MIN);
});

test("stats: usage is added as the difference against the running totals", () => {
  const { stats } = make(new Date(2026, 10, 4, 15, 0).getTime());
  stats.syncUsage(usage(1, 1000, 50));
  stats.syncUsage(usage(1, 1000, 50)); // nothing new: no change
  stats.syncUsage(usage(3, 4000, 250, 7));
  const [day] = stats.recent();
  assert.equal(day.requests, 3);
  assert.equal(day.steps, 7);
  assert.equal(day.tokensIn, 4000);
  assert.equal(day.tokensOut, 250);
  assert.ok(Math.abs(day.costUsd - 0.03) < 1e-9);
});

test("stats: days are kept apart and survive a restart", () => {
  const t0 = new Date(2026, 10, 4, 23, 55).getTime();
  const { stats, file, tick } = make(t0);
  stats.command();
  tick(10 * MIN); stats.command(); // after midnight: a new day, the gap across midnight is not counted
  stats.breakStarted();
  const reloaded = new DailyStats(file, () => t0 + 20 * MIN);
  const days = reloaded.recent();
  assert.deepEqual(days.map((d) => [d.date, d.commands, d.playMs, d.breaks]), [[dayKey(t0 + 10 * MIN), 1, 0, 1], [dayKey(t0), 1, 0, 0]]);
  reloaded.command();
  assert.equal(reloaded.recent()[0].commands, 2);
});

test("stats: a missing or broken file starts empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robo-stats-"));
  const file = path.join(dir, "stats.json");
  fs.writeFileSync(file, "{not json");
  const stats = new DailyStats(file, () => Date.now());
  assert.deepEqual(stats.recent(), []);
});
