import { test } from "node:test";
import assert from "node:assert/strict";
const { SentenceSplitter, cleanForSpeech } = await import("../server/src/agent/events.ts");
const { checkLuau, looksLikeDelete } = await import("../server/src/policy/luauGuard.ts");

test("splitter yields sentences as they complete", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push("Готово. Я сделал ла"), ["Готово."]);
  assert.deepEqual(s.push("ву! Хочешь ещё"), ["Я сделал лаву!"]);
  assert.deepEqual(s.flush(), ["Хочешь ещё"]);
});

test("cleanForSpeech strips code and paths", () => {
  const t = cleanForSpeech("Готово! ```lua\nprint(1)\n``` Объект `game.Workspace.Lava` **готов**.");
  assert.equal(t, "Готово! Объект готов.");
});

test("luau guard blocks dangerous services", () => {
  assert.equal(checkLuau("local p = Instance.new('Part')").ok, true);
  assert.equal(checkLuau("game:GetService('DataStoreService')").ok, false);
  assert.equal(checkLuau("game:GetService('HttpService'):GetAsync(url)").ok, false);
  assert.equal(checkLuau("workspace:ClearAllChildren()").ok, false);
  assert.equal(looksLikeDelete("part:Destroy()"), true);
  assert.equal(looksLikeDelete("part.Color = Color3.new(1,0,0)"), false);
});
