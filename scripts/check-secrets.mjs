// Ищет похожее на ключи и токены в файлах, отслеживаемых git. Запускать перед коммитом.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const patterns = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "ключ Anthropic"],
  [/xi-api-key"?\s*[:=]\s*"[A-Za-z0-9]{20,}/, "ключ ElevenLabs"],
  [/"apiKey"\s*:\s*"[^"*]{12,}"/, "apiKey в JSON"],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "токен GitHub"],
  [/"parentPin"\s*:\s*"(?!1234")[^"]+"/, "PIN родителя"],
  [/sk_[a-f0-9]{32,}/, "ключ вида sk_…"],
];
let bad = 0;
for (const f of files) {
  if (f === "scripts/check-secrets.mjs") continue;
  const text = fs.readFileSync(f, "utf8");
  for (const [re, what] of patterns) if (re.test(text)) { console.log(`СЕКРЕТ: ${what} в ${f}`); bad++; }
}
if (bad) { console.log(`\n${bad} находок. Секреты только в config/config.json (он в .gitignore).`); process.exit(1); }
console.log("секретов в отслеживаемых файлах нет");
