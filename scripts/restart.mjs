// Restarts the Robo server after an update. Started detached by server/src/update.ts:
//   node scripts/restart.mjs <old server pid> <commit before the update>
// Waits for the old server to exit (on Windows a running server locks files in node_modules, so
// npm cannot run inside it), installs dependencies when package-lock.json changed since the last
// install, rolls back to the previous commit if the install fails, then starts the server hidden.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [oldPid, before] = process.argv.slice(2);
const logFile = path.join(root, "robo.log");
const log = (kind, text) => fs.appendFileSync(logFile, `${new Date().toISOString()} [${kind}] restart: ${text}\n`);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when node_modules was installed from the current package-lock.json (stamp written after a successful install). */
export function depsUpToDate(dir) {
  try {
    const hash = crypto.createHash("sha1").update(fs.readFileSync(path.join(dir, "package-lock.json"))).digest("hex");
    return fs.readFileSync(path.join(dir, "node_modules", ".robo-lock-hash"), "utf8").trim() === hash ? hash : false;
  } catch { return false; }
}
export function stampDeps(dir) {
  const hash = crypto.createHash("sha1").update(fs.readFileSync(path.join(dir, "package-lock.json"))).digest("hex");
  fs.writeFileSync(path.join(dir, "node_modules", ".robo-lock-hash"), hash);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "pipe", windowsHide: true, shell: process.platform === "win32", timeout: 600_000 });

if (oldPid) {
  const pid = Number(oldPid);
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(500);
  if (alive(pid)) log("error", `old server ${pid} is still running, starting anyway`);
}

if (!depsUpToDate(root)) {
  log("system", "dependencies changed, running npm ci");
  try {
    run(npm, ["ci", "--no-audit", "--no-fund"]);
    stampDeps(root);
    log("system", "dependencies installed");
  } catch (e) {
    log("error", `npm ci failed: ${String(e.stderr ?? e.message).split("\n").slice(-3).join(" ").slice(0, 300)}`);
    if (before) {
      try {
        run("git", ["reset", "--hard", before]);
        log("error", `rolled back to ${before.slice(0, 7)}; the update will be retried later`);
      } catch (e2) { log("error", `rollback failed: ${String(e2.message).slice(0, 200)}`); }
    }
  }
}

const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const child = spawn(process.execPath, [tsx, path.join("server", "src", "index.ts")], {
  cwd: root, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env },
});
child.unref();
log("system", `server started, pid ${child.pid}`);
process.exit(0);
