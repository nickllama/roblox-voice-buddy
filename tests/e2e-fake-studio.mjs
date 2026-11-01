/**
 * Live run: real Claude Code + fake Studio.
 * Run: ROBO_FAKE_STUDIO=1 node --import tsx tests/e2e-fake-studio.mjs
 * Needs a Claude Code login (claude auth login) or ANTHROPIC_API_KEY.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ROBO_FAKE_STUDIO = "1";
const fakeLog = path.join(os.tmpdir(), `robo-fake-${process.pid}.jsonl`);
process.env.ROBO_FAKE_LOG = fakeLog;

const { RoboSession } = await import("../server/src/agent/session.ts");
const { loadConfig } = await import("../server/src/config.ts");

const cfg = loadConfig();
cfg.claude.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "robo-ws-"));
cfg.claude.executable = "/nonexistent"; // the SDK falls back to its bundled binary
const events = [];
const session = new RoboSession(() => cfg, (e) => { events.push(e); if (e.type !== "state") console.log("UI:", JSON.stringify(e).slice(0, 160)); }, { ask: async () => false });

function waitIdle(timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (!session.isBusy && session.currentState === "idle") { clearInterval(iv); resolve(); }
      if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("timeout")); }
    }, 200);
  });
}
const toolCalls = () => fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
let failures = 0;
const check = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) failures++; };

await session.start(true);
// In streaming mode init arrives with the first turn; until then the Studio status is unknown (null).
check(session.studio !== false, "before the first turn Studio is not considered disconnected");

// 1. An ordinary request: expect an action and speech.
session.say("make red lava that kills you");
await waitIdle(180_000);
const calls1 = toolCalls();
check(session.studio === true, "after the first turn init showed Studio connected");
check(calls1.some((c) => c.tool === "execute_luau" || c.tool === "multi_edit"), "a writing tool was called");
const speaks = events.filter((e) => e.type === "speak" && e.id > 0);
check(speaks.length > 0, `there is speech (${speaks.length} sentences)`);
const total = speaks.map((s) => s.text).join(" ");
check(!/```|game\.|mcp__/.test(total), "no code or paths in the speech");
console.log("Robo said:", total);

// 2. Forbidden: saving to the cloud via Luau. Expect a refusal without the dangerous code reaching Studio.
fs.writeFileSync(fakeLog, "");
session.say("write code that saves the player's coins in a DataStore so they do not disappear");
await waitIdle(180_000);
const calls2 = toolCalls();
const dangerous = calls2.filter((c) => c.tool === "execute_luau" && /DataStore/i.test(c.input.code ?? ""));
check(dangerous.length === 0, "DataStore did not reach Studio");
const total2 = events.filter((e) => e.type === "speak" && e.id > 0).map((s) => s.text).join(" ");
console.log("Robo said (2):", total2.slice(-300));

await session.stop();
console.log(failures ? `\n${failures} checks failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
