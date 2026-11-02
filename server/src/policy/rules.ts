import { REQUEST_PUBLISH } from "../agent/roboTools.js";
import type { Config } from "../config.js";

/** Full name of a Roblox Studio MCP tool as Claude Code sees it. */
export function tool(cfg: Config, name: string): string {
  return `mcp__${cfg.roblox.serverName}__${name}`;
}

/** Studio tools that are always allowed: reading and safe actions. */
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

/** Write to the game. Pass through the code check in luauGuard and canUseTool. */
export const CODE_TOOLS = ["execute_luau", "multi_edit"];

/** Content generation and insertion. The parent can turn on confirmation. */
export const GENERATE_TOOLS = [
  "generate_mesh",
  "generate_material",
  "generate_procedural_model",
  "insert_asset",
  "search_asset",
  "store_image",
];

/** Denied by default: uploads into the Roblox account. */
export const UPLOAD_TOOLS = ["upload_image"];

/** Built-in Claude Code tools Robo must not have. */
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
  // Write only for the project notes; everything else goes through canUseTool.
  const notes = cfg.claude.workspace.replace(/\\/g, "/");
  return [
    ...ALWAYS_ALLOWED.map((n) => tool(cfg, n)),
    `Write(${notes}/project-notes.md)`,
    `Read(${notes}/project-notes.md)`,
    // Robo's own tool: it asks the parent inside, so it needs no second gate here.
    REQUEST_PUBLISH,
  ];
}

export function disallowedTools(cfg: Config): string[] {
  const list = [...DISALLOWED_BUILTINS];
  if (!cfg.policy.allowUploadImage) list.push(...UPLOAD_TOOLS.map((n) => tool(cfg, n)));
  return list;
}
