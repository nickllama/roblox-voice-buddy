#!/usr/bin/env node
/**
 * Fake Roblox Studio: a stdio MCP server with the same tool names as Studio's built-in server.
 * For development without Studio and for E2E tests.
 * Keeps an object tree in memory and "runs" Luau very roughly: creates a Part per Instance.new.
 * Writes every call to the file named by ROBO_FAKE_LOG (one JSON object per line) when set.
 */
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOG = process.env.ROBO_FAKE_LOG;
const tree = { Workspace: { Baseplate: { ClassName: "Part", Size: "512,20,512", Color: "gray" }, SpawnLocation: { ClassName: "SpawnLocation" } }, ServerScriptService: {}, StarterGui: {} };
const scripts = {};
let playing = false;

function record(tool, input) {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), tool, input }) + "\n");
}
const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 1) }] });

const server = new McpServer({ name: "Roblox_Studio", version: "0.0.1-fake" });
const sid = z.string().optional().describe("Studio instance ID");

server.tool("list_roblox_studios", "List connected Studio instances", {}, async () => {
  record("list_roblox_studios", {});
  return text([{ name: "My Game (fake)", studio_id: "fake-1", place_id: null }]);
});
server.tool("get_studio_state", "Play state and datamodel types", { studio_id: sid }, async (a) => {
  record("get_studio_state", a);
  return text({ playing, datamodel_types: playing ? ["Edit", "Server", "Client"] : ["Edit"] });
});
server.tool("search_game_tree", "Instance hierarchy", { studio_id: sid, path: z.string().optional(), keyword: z.string().optional(), depth: z.number().optional() }, async (a) => {
  record("search_game_tree", a);
  return text(tree);
});
server.tool("inspect_instance", "Properties of an instance", { studio_id: sid, path: z.string() }, async (a) => {
  record("inspect_instance", a);
  const parts = a.path.replace(/^game\./, "").split(".");
  let node = tree; for (const p of parts) node = node?.[p];
  return text(node ?? { error: "not found" });
});
server.tool("execute_luau", "Run Luau code", { studio_id: sid, code: z.string(), datamodel_type: z.enum(["Edit", "Server", "Client"]).optional() }, async (a) => {
  record("execute_luau", a);
  // Very rough emulation: every Instance.new("Part") followed by .Name = "X" creates an object.
  const re = /Instance\.new\(\s*["'](\w+)["']\s*\)[\s\S]*?\.Name\s*=\s*["']([^"']+)["']/g;
  let m, created = [];
  while ((m = re.exec(a.code)) !== null) { tree.Workspace[m[2]] = { ClassName: m[1] }; created.push(m[2]); }
  if (/:Destroy\(\)/.test(a.code)) { const d = /(\w+)\s*:Destroy\(\)/.exec(a.code); if (d) delete tree.Workspace[d[1]]; }
  return text({ ok: true, output: created.length ? `created: ${created.join(", ")}` : "ok" });
});
server.tool("multi_edit", "Edit or create scripts", { studio_id: sid, path: z.string(), edits: z.array(z.object({ old: z.string().optional(), new: z.string() })).optional(), source: z.string().optional() }, async (a) => {
  record("multi_edit", a);
  scripts[a.path] = a.source ?? (a.edits ?? []).map((e) => e.new).join("\n");
  return text({ ok: true, path: a.path });
});
server.tool("script_read", "Read a script", { studio_id: sid, path: z.string() }, async (a) => {
  record("script_read", a);
  return text(scripts[a.path] ?? "");
});
server.tool("start_stop_play", "Start or stop playtest", { studio_id: sid, action: z.enum(["start", "stop"]).optional() }, async (a) => {
  record("start_stop_play", a);
  playing = a.action !== "stop";
  return text({ playing });
});
server.tool("get_console_output", "Output log", { studio_id: sid }, async (a) => { record("get_console_output", a); return text("(empty)"); });
server.tool("screen_capture", "Viewport image", { studio_id: sid }, async (a) => { record("screen_capture", a); return text("(fake: screenshot unavailable)"); });

await server.connect(new StdioServerTransport());
