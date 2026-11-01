/**
 * Обновление Робо из git: проверка, применение, перезапуск сервера.
 * Перезапуск: сессия останавливается, HTTP закрывается, стартует новый процесс,
 * старый выходит. Страница в Edge переподключается сама, сессия Claude возобновляется.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ROOT } from "./config.js";
import { log } from "./log.js";

const run = promisify(execFile);

export type UpdateStatus = {
  current: string;        // короткий хэш и дата текущей версии
  available: boolean;     // есть ли новые коммиты на origin
  incoming: string[];     // их заголовки
  checkedAt: number | null;
  error: string | null;
  applying: boolean;
};

const status: UpdateStatus = { current: "?", available: false, incoming: [], checkedAt: null, error: null, applying: false };

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: ROOT, windowsHide: true, timeout: 60_000 });
  return stdout.trim();
}

export async function currentVersion(): Promise<string> {
  try { status.current = await git("log", "-1", "--format=%h %cd", "--date=format:%d.%m %H:%M"); } catch { status.current = "не git"; }
  return status.current;
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  try {
    await currentVersion();
    await git("fetch", "--quiet", "origin", "main");
    const list = await git("log", "--oneline", "HEAD..origin/main");
    status.incoming = list ? list.split("\n") : [];
    status.available = status.incoming.length > 0;
    status.error = null;
  } catch (e) {
    status.error = String((e as Error).message ?? e).split("\n")[0];
    log("error", `проверка обновлений: ${status.error}`);
  }
  status.checkedAt = Date.now();
  return { ...status };
}

export function getStatus(): UpdateStatus { return { ...status }; }

/** Тянет изменения и при смене package-lock ставит зависимости. Возвращает true, если что-то обновилось. */
export async function applyUpdate(): Promise<boolean> {
  if (status.applying) return false;
  status.applying = true;
  try {
    const before = await git("rev-parse", "HEAD");
    await git("pull", "--ff-only", "--quiet", "origin", "main");
    const after = await git("rev-parse", "HEAD");
    if (before === after) { status.available = false; return false; }
    const changed = await git("diff", "--name-only", before, after);
    if (/(^|\n)package(-lock)?\.json($|\n)/.test(changed)) {
      log("system", "зависимости изменились, npm ci");
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      await run(npm, ["ci", "--no-audit", "--no-fund"], { cwd: ROOT, windowsHide: true, timeout: 600_000, shell: process.platform === "win32" });
    }
    log("system", `обновлено ${before.slice(0, 7)} → ${after.slice(0, 7)}`);
    status.available = false; status.incoming = [];
    await currentVersion();
    return true;
  } catch (e) {
    status.error = String((e as Error).message ?? e).split("\n")[0];
    log("error", `обновление не удалось: ${status.error}`);
    return false;
  } finally {
    status.applying = false;
  }
}

/** Запускает новый экземпляр сервера и завершает текущий. Вызывающий код должен закрыть порт до этого. */
export function relaunch(): void {
  const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, path.join("server", "src", "index.ts")], {
    cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env },
  });
  child.unref();
  log("system", `перезапуск, новый процесс ${child.pid}`);
  setTimeout(() => process.exit(0), 300);
}
