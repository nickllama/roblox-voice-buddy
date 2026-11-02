import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "../log.js";
import type { ParentGate } from "../policy/canUseTool.js";

/** Name of the in-process MCP server with Robo's own tools, as Claude sees it: mcp__robo__<tool>. */
export const ROBO_SERVER = "robo";
export const REQUEST_PUBLISH = `mcp__${ROBO_SERVER}__request_publish`;

export interface RoboToolActions {
  /** Runs the publish (Alt+P in Studio). Resolves with a short status, rejects on failure. */
  publish(): Promise<string>;
  /** A short phrase spoken to the child while the parent is asked. */
  notice(text: string): void;
  /** The phrase to speak while the parent is asked. */
  askParentPhrase(): string;
}

/** How long the parent has to answer the publish question. */
export const PUBLISH_ASK_MS = 120_000;

/**
 * request_publish: Claude prepares the game, then asks for permission here. The parent answers in the
 * panel; only a "yes" runs scripts/publish.ps1. Claude never publishes on its own: this is the one path,
 * and the decision is always a person's.
 */
export async function requestPublish(summary: string, gate: ParentGate, actions: RoboToolActions): Promise<string> {
  const what = summary.trim().slice(0, 300) || "the game";
  log("tool", `request_publish: ${what}`);
  actions.notice(actions.askParentPhrase());
  const ok = await gate.ask(`Robo prepared the game for publishing: ${what}. Publish it to Roblox now (Alt+P in Studio)?`, PUBLISH_ASK_MS);
  if (!ok) {
    log("tool", "request_publish: the parent said no or did not answer");
    return "Not published: the parent did not approve it right now. Tell the child it will happen another time, and keep building.";
  }
  try {
    const out = await actions.publish();
    log("parent", `publish approved from the panel: ${out}`);
    return "The parent approved and the publish was sent to Studio. The first time, a grown-up finishes Studio's dialog (name, Create). Tell the child the game is on its way.";
  } catch (e) {
    log("error", `publish failed: ${String((e as Error).message ?? e)}`);
    return "The parent approved, but Studio did not take the publish command. Tell the child a grown-up will do it by hand.";
  }
}

export function buildRoboServer(gate: ParentGate, actions: RoboToolActions): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: ROBO_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "request_publish",
        "Ask the parent to publish the game to Roblox. Call it only after the child asked to publish or share the game and you checked that it can be played. The parent decides in their panel; the result tells you what happened.",
        { summary: z.string().describe("One short sentence about the game, for the parent: what it is and what was built.") },
        async (args) => ({ content: [{ type: "text", text: await requestPublish(args.summary, gate, actions) }] }),
      ),
    ],
  });
}
