/**
 * Updating Robo from git: check, pull, restart the server.
 * Dependencies are never installed from inside the running server: on Windows the process locks
 * files in node_modules. Instead relaunch() hands over to scripts/restart.mjs, which waits for this
 * process to exit, runs npm ci when package-lock.json changed, rolls back if that fails, and starts
 * the server again. The Edge page reconnects on its own, the Claude session resumes.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ROOT } from "./config.js";
import { log } from "./log.js";

const run = promisify(execFile);

export type UpdateStatus = {
  current: string;        // short hash and date of the current version
  available: boolean;     // whether origin has new commits
  incoming: string[];     // their subjects
  checkedAt: number | null;
  error: string | null;
  applying: boolean;
};

const status: UpdateStatus = { current: "?", available: false, incoming: [], checkedAt: null, error: null, applying: false };
/** Commit before the last successful pull; restart.mjs rolls back to it when the install fails. */
let beforeUpdate: string | null = null;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: ROOT, windowsHide: true, timeout: 60_000 });
  return stdout.trim();
}

export async function currentVersion(): Promise<string> {
  try { status.current = await git("log", "-1", "--format=%h %cd", "--date=format:%Y-%m-%d %H:%M"); } catch { status.current = "not a git checkout"; }
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
    log("error", `update check: ${status.error}`);
  }
  status.checkedAt = Date.now();
  return { ...status };
}

export function getStatus(): UpdateStatus { return { ...status }; }

/** Pulls changes. Returns true if anything was updated; the caller then restarts through relaunch(). */
export async function applyUpdate(): Promise<boolean> {
  if (status.applying) return false;
  status.applying = true;
  try {
    const before = await git("rev-parse", "HEAD");
    await git("pull", "--ff-only", "--quiet", "origin", "main");
    const after = await git("rev-parse", "HEAD");
    if (before === after) { status.available = false; return false; }
    beforeUpdate = before;
    const changed = await git("diff", "--name-only", before, after);
    if (/(^|\n)package(-lock)?\.json($|\n)/.test(changed)) log("system", "dependencies changed; they are installed during the restart");
    log("system", `updated ${before.slice(0, 7)} -> ${after.slice(0, 7)}`);
    status.available = false; status.incoming = [];
    await currentVersion();
    return true;
  } catch (e) {
    status.error = String((e as Error).message ?? e).split("\n")[0];
    log("error", `update failed: ${status.error}`);
    return false;
  } finally {
    status.applying = false;
  }
}

/** Hands over to scripts/restart.mjs and exits. The caller must close the port before this. */
export function relaunch(): void {
  const script = path.join(ROOT, "scripts", "restart.mjs");
  const child = spawn(process.execPath, [script, String(process.pid), beforeUpdate ?? ""], {
    cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env },
  });
  child.unref();
  log("system", `restarting through restart.mjs (pid ${child.pid})`);
  setTimeout(() => process.exit(0), 300);
}
