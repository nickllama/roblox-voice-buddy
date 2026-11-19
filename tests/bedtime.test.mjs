import { test } from "node:test";
import assert from "node:assert/strict";
import { Bedtime, localClock, parseHM, validTimeZone } from "../server/src/bedtime.ts";

const cfg = { enabled: true, warnAt: "20:15", at: "20:30", wakeAt: "07:00", timeZone: "Europe/Madrid" };
// 2026-11-19 in Madrid is UTC+1
const madrid = (hm, day = "2026-11-19") => Date.parse(`${day}T${hm}:00+01:00`);

test("bedtime: times and zones", () => {
  assert.equal(parseHM("20:15"), 20 * 60 + 15);
  assert.equal(parseHM("7.05"), 7 * 60 + 5);
  assert.equal(parseHM("25:00"), null);
  assert.equal(parseHM("soon"), null);
  assert.equal(localClock(madrid("20:15"), "Europe/Madrid").hm, "20:15");
  assert.equal(localClock(madrid("20:15"), "UTC").hm, "19:15");
  assert.equal(validTimeZone("Europe/Madrid"), true);
  assert.equal(validTimeZone("Mars/Base"), false);
  assert.equal(validTimeZone(""), true);
});

test("bedtime: a warning at 20:15 once, good night at 20:30 once, by the zone and not the PC", () => {
  const b = new Bedtime();
  assert.equal(b.check(cfg, madrid("20:00")), null);
  const w = b.check(cfg, madrid("20:15"));
  assert.deepEqual(w, { kind: "warn", minutesLeft: 15 });
  b.markWarned(cfg, madrid("20:15"));
  assert.equal(b.check(cfg, madrid("20:20")), null);
  const s = b.check(cfg, madrid("20:30"));
  assert.equal(s.kind, "sleep");
  assert.equal(s.msUntilWake, (10 * 60 + 30) * 60_000);
  b.markSlept(cfg, madrid("20:30"));
  assert.equal(b.check(cfg, madrid("23:00")), null);
  assert.equal(b.check(cfg, madrid("02:00", "2026-11-20")), null); // the same night
  assert.equal(b.check(cfg, madrid("08:00", "2026-11-20")), null); // morning
  assert.deepEqual(b.check(cfg, madrid("20:16", "2026-11-20")), { kind: "warn", minutesLeft: 14 }); // next evening again
});

test("bedtime: Robo started after bedtime goes to bed at once; a parent's Continue holds for the night", () => {
  const b = new Bedtime();
  assert.equal(b.check(cfg, madrid("21:40")).kind, "sleep");
  b.allowTonight(cfg, madrid("21:41"));
  assert.equal(b.check(cfg, madrid("22:30")), null);
  assert.equal(b.check(cfg, madrid("01:00", "2026-11-20")), null);
  assert.equal(b.check(cfg, madrid("20:30", "2026-11-20")).kind, "sleep");
});

test("bedtime: off does nothing", () => {
  assert.equal(new Bedtime().check({ ...cfg, enabled: false }, madrid("21:00")), null);
});

test("bedtime: minutes said with the right word form", async () => {
  const { minutes, phrases } = await import("../server/src/i18n.ts");
  const ru = phrases("ru-RU"), en = phrases("en-US");
  assert.deepEqual([1, 2, 5, 11, 15, 21, 22, 25].map((n) => minutes(n, ru)), ["1 минуту", "2 минуты", "5 минут", "11 минут", "15 минут", "21 минуту", "22 минуты", "25 минут"]);
  assert.equal(minutes(1, en), "1 minute");
  assert.equal(minutes(15, en), "15 minutes");
});

test("bedtime: 19:45 warning is 15 minutes before 20:00", () => {
  const b = new Bedtime();
  const c = { ...cfg, warnAt: "19:45", at: "20:00" };
  assert.deepEqual(b.check(c, madrid("19:45")), { kind: "warn", minutesLeft: 15 });
  assert.equal(b.check(c, madrid("20:00")).kind, "sleep");
});
