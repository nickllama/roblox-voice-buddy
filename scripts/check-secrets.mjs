// Looks for things that resemble keys and tokens in files tracked by git. Run before committing.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const patterns = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic key"],
  [/xi-api-key"?\s*[:=]\s*"[A-Za-z0-9]{20,}/, "ElevenLabs key"],
  [/"apiKey"\s*:\s*"[^"*]{12,}"/, "apiKey in JSON"],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/"parentPin"\s*:\s*"(?!1234")[^"]+"/, "parent PIN"],
  [/sk_[a-f0-9]{32,}/, "sk_… style key"],
];
let bad = 0;
for (const f of files) {
  if (f === "scripts/check-secrets.mjs") continue;
  const text = fs.readFileSync(f, "utf8");
  for (const [re, what] of patterns) if (re.test(text)) { console.log(`SECRET: ${what} in ${f}`); bad++; }
}
if (bad) { console.log(`\n${bad} finding(s). Secrets belong only in config/config.json (it is in .gitignore).`); process.exit(1); }
console.log("no secrets in tracked files");
