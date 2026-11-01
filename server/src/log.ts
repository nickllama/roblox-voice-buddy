import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

export type LogEntry = {
  t: number;
  kind: "child" | "robo" | "tool" | "parent" | "system" | "error";
  text: string;
};

const MAX = 500;
const entries: LogEntry[] = [];
const file = path.join(ROOT, "robo.log");

export function log(kind: LogEntry["kind"], text: string): LogEntry {
  const e: LogEntry = { t: Date.now(), kind, text };
  entries.push(e);
  if (entries.length > MAX) entries.shift();
  const line = `${new Date(e.t).toISOString()} [${kind}] ${text.replace(/\n/g, " ")}\n`;
  fs.appendFile(file, line, () => {});
  if (kind === "error") console.error(line.trim());
  else console.log(line.trim());
  return e;
}

export function recent(n = 200): LogEntry[] {
  return entries.slice(-n);
}
