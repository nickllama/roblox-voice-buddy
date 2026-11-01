import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { type Config, ROOT } from "./config.js";

export interface StudioProbe {
  connected: boolean;
  /** Short human-readable detail: instance count, or the error text. */
  detail: string;
}

/**
 * Asks Studio's MCP launcher directly for the list of open Studio instances: list_roblox_studios
 * over stdio, no Claude involved, so the "Studio connected" status is known before the first request.
 * ROBO_FAKE_STUDIO=1 probes the fake Studio from tools/ instead.
 */
export async function probeStudio(cfg: Config, timeoutMs = 8000): Promise<StudioProbe> {
  const env = { ...process.env as Record<string, string> };
  const transport = process.env.ROBO_FAKE_STUDIO
    ? new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "tools", "fake-studio-mcp.mjs")], env })
    : new StdioClientTransport({ command: "cmd.exe", args: ["/c", cfg.roblox.mcpBat], env });
  const client = new Client({ name: "robo-probe", version: "0.1.0" });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Studio launcher did not answer in time")), timeoutMs); });
  timeout.catch(() => {});
  try {
    await Promise.race([client.connect(transport), timeout]);
    const res = (await Promise.race([client.callTool({ name: "list_roblox_studios", arguments: {} }), timeout])) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? []).map((c) => c.text ?? "").join("\n").trim();
    if (res.isError) return { connected: false, detail: text.slice(0, 200) || "launcher returned an error" };
    const count = countStudios(text);
    return { connected: count > 0, detail: count > 0 ? `${count} open Studio instance(s)` : (text.slice(0, 200) || "no open Studio") };
  } catch (e) {
    return { connected: false, detail: String((e as Error).message ?? e).split("\n")[0] };
  } finally {
    if (timer) clearTimeout(timer);
    try { await client.close(); } catch {}
  }
}

/** The launcher's answer is JSON (an array, or an object with a list inside); fall back to a text heuristic. */
export function countStudios(text: string): number {
  try {
    const j: unknown = JSON.parse(text);
    if (Array.isArray(j)) return j.length;
    if (j && typeof j === "object") {
      for (const v of Object.values(j as Record<string, unknown>)) if (Array.isArray(v)) return v.length;
    }
    return 0;
  } catch {
    return /studio_id|place_id|\bname\b/i.test(text) && !/no (open )?studio|not connected|0 studios/i.test(text) ? 1 : 0;
  }
}
