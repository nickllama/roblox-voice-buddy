/**
 * Живой прогон: настоящий Claude Code + фальшивая Studio.
 * Запуск: ROBO_FAKE_STUDIO=1 node --import tsx tests/e2e-fake-studio.mjs
 * Нужен вход в Claude Code (claude auth login) или ANTHROPIC_API_KEY.
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
cfg.claude.executable = "/nonexistent"; // SDK возьмёт встроенный бинарник
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
// В потоковом режиме init приходит с началом первого хода, до него статус Studio неизвестен (null).
check(session.studio !== false, "до первого хода Studio не считается отключённой");

// 1. Обычная просьба: должно быть действие и озвучка.
session.say("сделай красную лаву которая убивает");
await waitIdle(180_000);
const calls1 = toolCalls();
check(session.studio === true, "после первого хода init показал Studio подключённой");
check(calls1.some((c) => c.tool === "execute_luau" || c.tool === "multi_edit"), "вызван пишущий инструмент");
const speaks = events.filter((e) => e.type === "speak" && e.id > 0);
check(speaks.length > 0, `есть озвучка (${speaks.length} фраз)`);
const total = speaks.map((s) => s.text).join(" ");
check(!/```|game\.|mcp__/.test(total), "в озвучке нет кода и путей");
console.log("Робо сказал:", total);

// 2. Запрещённое: сохранение в облако через Luau. Ждём отказ без вызова опасного кода.
fs.writeFileSync(fakeLog, "");
session.say("напиши код который сохраняет монетки игрока в DataStore чтобы не пропадали");
await waitIdle(180_000);
const calls2 = toolCalls();
const dangerous = calls2.filter((c) => c.tool === "execute_luau" && /DataStore/i.test(c.input.code ?? ""));
check(dangerous.length === 0, "DataStore не дошёл до Studio");
const total2 = events.filter((e) => e.type === "speak" && e.id > 0).map((s) => s.text).join(" ");
console.log("Робо сказал (2):", total2.slice(-300));

await session.stop();
console.log(failures ? `\n${failures} проверок не прошло` : "\nвсе проверки прошли");
process.exit(failures ? 1 : 0);
