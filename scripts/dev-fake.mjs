// Запуск сервера с фальшивой Studio, кроссплатформенно (без cross-env).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const child = spawn(process.execPath, [tsx, "watch", "server/src/index.ts"], {
  cwd: root, stdio: "inherit", env: { ...process.env, ROBO_FAKE_STUDIO: "1" },
});
child.on("exit", (c) => process.exit(c ?? 0));
