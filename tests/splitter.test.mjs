import { test } from "node:test";
import assert from "node:assert/strict";
const { SentenceSplitter, cleanForSpeech } = await import("../server/src/agent/events.ts");
const { checkLuau, looksLikeDelete } = await import("../server/src/policy/luauGuard.ts");

test("splitter yields sentences as they complete", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push("Done. I made the la"), ["Done."]);
  assert.deepEqual(s.push("va! Want more"), ["I made the lava!"]);
  assert.deepEqual(s.flush(), ["Want more"]);
});

test("cleanForSpeech strips code and paths", () => {
  const t = cleanForSpeech("Done! ```lua\nprint(1)\n``` The `game.Workspace.Lava` part is **ready**.");
  assert.equal(t, "Done! The part is ready.");
});

test("cleanForSpeech replaces paths with a word in the child's language", () => {
  assert.equal(cleanForSpeech("See game.Workspace.Lava", "en"), "See object");
  assert.equal(cleanForSpeech("Смотри game.Workspace.Lava", "ru-RU"), "Смотри объект");
});

test("luau guard blocks dangerous services", () => {
  assert.equal(checkLuau("local p = Instance.new('Part')").ok, true);
  assert.equal(checkLuau("game:GetService('DataStoreService')").ok, false);
  assert.equal(checkLuau("game:GetService('HttpService'):GetAsync(url)").ok, false);
  assert.equal(checkLuau("workspace:ClearAllChildren()").ok, false);
  assert.equal(looksLikeDelete("part:Destroy()"), true);
  assert.equal(looksLikeDelete("part.Color = Color3.new(1,0,0)"), false);
});
