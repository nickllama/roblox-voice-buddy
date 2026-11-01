import type { Config } from "../config.js";

/** Полное имя MCP-инструмента Roblox Studio в Claude Code. */
export function tool(cfg: Config, name: string): string {
  return `mcp__${cfg.roblox.serverName}__${name}`;
}

/** Инструменты Studio, которые разрешены всегда: чтение и безопасные действия. */
export const ALWAYS_ALLOWED = [
  "list_roblox_studios",
  "get_studio_state",
  "search_game_tree",
  "inspect_instance",
  "script_read",
  "script_search",
  "script_grep",
  "get_console_output",
  "screen_capture",
  "http_get",
  "skill",
  "subagent",
  "wait_job_finished",
  "start_stop_play",
  "character_navigation",
  "user_keyboard_input",
  "user_mouse_input",
];

/** Пишут в игру. Проходят через проверку кода в luauGuard и canUseTool. */
export const CODE_TOOLS = ["execute_luau", "multi_edit"];

/** Генерация и вставка контента. Родитель может включить подтверждение. */
export const GENERATE_TOOLS = [
  "generate_mesh",
  "generate_material",
  "generate_procedural_model",
  "insert_asset",
  "search_asset",
  "store_image",
];

/** Запрещено по умолчанию: загружает в аккаунт Roblox. */
export const UPLOAD_TOOLS = ["upload_image"];

/** Встроенные инструменты Claude Code, которых у Робо быть не должно. */
export const DISALLOWED_BUILTINS = [
  "Bash",
  "PowerShell",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
  "KillShell",
  "BashOutput",
];

export function allowedTools(cfg: Config): string[] {
  // Write только для заметок проекта, остальное через canUseTool.
  const notes = cfg.claude.workspace.replace(/\\/g, "/");
  return [
    ...ALWAYS_ALLOWED.map((n) => tool(cfg, n)),
    `Write(${notes}/project-notes.md)`,
    `Read(${notes}/project-notes.md)`,
  ];
}

export function disallowedTools(cfg: Config): string[] {
  const list = [...DISALLOWED_BUILTINS];
  if (!cfg.policy.allowUploadImage) list.push(...UPLOAD_TOOLS.map((n) => tool(cfg, n)));
  return list;
}
