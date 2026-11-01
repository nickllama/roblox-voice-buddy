import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
const CONFIG_DIR = path.join(ROOT, "config");

export type SttProvider = "webspeech" | "deepgram" | "whisper";
export type TtsProvider = "edge" | "elevenlabs" | "piper";

export interface Config {
  port: number;
  bindHost: string;
  parentPin: string;
  hotkey: string;
  language: string;
  claude: {
    executable: string;
    workspace: string;
    model: string | null;
    maxTurns: number;
  };
  roblox: { mcpBat: string; serverName: string };
  policy: {
    askBeforeDelete: boolean;
    askBeforeGenerate: boolean;
    allowUploadImage: boolean;
  };
  stt: {
    provider: SttProvider;
    deepgram: { apiKey: string; model: string };
  };
  tts: {
    provider: TtsProvider;
    elevenlabs: { apiKey: string; voiceId: string; model: string };
    edge: { voiceMatch: string };
  };
  session: { maxMinutes: number };
  update: { checkIntervalMin: number; auto: boolean };
}

/** Раскрывает %VAR% и $VAR в путях из конфига. */
export function expandEnv(value: string): string {
  return value
    .replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`)
    .replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (m, name) => process.env[name] ?? m);
}

function deepMerge<T extends Record<string, unknown>>(base: T, over: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)) {
      out[k] = deepMerge(b as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export function configPath(): string {
  return path.join(CONFIG_DIR, "config.json");
}

export function loadConfig(): Config {
  const example = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.example.json"), "utf8")) as Config;
  const localPath = configPath();
  const local = fs.existsSync(localPath) ? (JSON.parse(fs.readFileSync(localPath, "utf8")) as Partial<Config>) : {};
  const cfg = deepMerge(example as unknown as Record<string, unknown>, local as Record<string, unknown>) as unknown as Config;
  cfg.claude.executable = expandEnv(cfg.claude.executable);
  cfg.claude.workspace = expandEnv(cfg.claude.workspace);
  cfg.roblox.mcpBat = expandEnv(cfg.roblox.mcpBat);
  // Вне Windows переменные %...% не раскрываются: рабочая папка тогда внутри проекта.
  if (/%[^%]+%/.test(cfg.claude.workspace)) cfg.claude.workspace = path.join(ROOT, "workspace");
  return cfg;
}

export function saveConfigPatch(patch: Record<string, unknown>): Config {
  const localPath = configPath();
  const local = fs.existsSync(localPath) ? (JSON.parse(fs.readFileSync(localPath, "utf8")) as Record<string, unknown>) : {};
  const merged = deepMerge(local, patch);
  fs.writeFileSync(localPath, JSON.stringify(merged, null, 2));
  return loadConfig();
}

/** Промпт: prompt.local.md (правки родителя) имеет приоритет над prompt.md из репозитория. */
export function promptPath(): string {
  const local = path.join(CONFIG_DIR, "prompt.local.md");
  return fs.existsSync(local) ? local : path.join(CONFIG_DIR, "prompt.md");
}

export function loadPrompt(): string {
  return fs.readFileSync(promptPath(), "utf8");
}

export function savePrompt(text: string): void {
  fs.writeFileSync(path.join(CONFIG_DIR, "prompt.local.md"), text);
}

export function notesPath(cfg: Config): string {
  return path.join(cfg.claude.workspace, "project-notes.md");
}

export function loadNotes(cfg: Config): string {
  const p = notesPath(cfg);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

export function ensureWorkspace(cfg: Config): void {
  fs.mkdirSync(cfg.claude.workspace, { recursive: true });
  const p = notesPath(cfg);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, "# Что уже построено\n\n(пока ничего)\n");
  }
}
