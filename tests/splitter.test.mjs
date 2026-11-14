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
  assert.equal(checkLuau("game:GetService('HttpService'):PostAsync(url, body)").ok, false);
  assert.equal(looksLikeDelete("part:Destroy()"), true);
  assert.equal(looksLikeDelete("part.Color = Color3.new(1,0,0)"), false);
});

test("luau guard: saving progress passes only when the parent turned it on", () => {
  const save = `local store = game:GetService("DataStoreService"):GetDataStore("Progress")
local ok, data = pcall(function() return store:GetAsync("p_" .. player.UserId) end)
pcall(function() store:SetAsync("p_" .. player.UserId, { coins = 5 }) end)
pcall(function() store:UpdateAsync("p_" .. player.UserId, function(old) return old end) end)`;
  const off = checkLuau(save);
  assert.equal(off.ok, false);
  assert.match(off.reason, /parent panel/);
  const on = { saveProgress: true };
  assert.equal(checkLuau(save, on).ok, true);
  // Still closed with saving on: deleting and listing saved data, ordered and memory stores, the internet, purchases.
  assert.equal(checkLuau('store:RemoveAsync("p_1")', on).ok, false);
  assert.equal(checkLuau('game:GetService("DataStoreService"):GetOrderedDataStore("Top")', on).ok, false);
  assert.equal(checkLuau('game:GetService("DataStoreService"):ListDataStoresAsync()', on).ok, false);
  assert.equal(checkLuau('game:GetService("MemoryStoreService")', on).ok, false);
  assert.equal(checkLuau("game:GetService('HttpService'):GetAsync(url)", on).ok, false);
  assert.equal(checkLuau("game:GetService('MarketplaceService')", on).ok, false);
});
