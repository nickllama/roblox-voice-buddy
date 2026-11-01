import type { CanUseTool, HookCallbackMatcher, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { phrases } from "../i18n.js";
import { log } from "../log.js";
import { checkLuau, extractCode, looksLikeDelete } from "./luauGuard.js";
import { CODE_TOOLS, GENERATE_TOOLS, tool } from "./rules.js";

/** Channel to the parent: a question, an answer within the timeout, otherwise a refusal. */
export interface ParentGate {
  ask(question: string, timeoutMs: number): Promise<boolean>;
}

export interface PolicyEvents {
  /** A short phrase spoken to the child while a tool is refused or the parent is asked. */
  onChildNotice(text: string): void;
}

export function buildCanUseTool(getCfg: () => Config, gate: ParentGate, ev: PolicyEvents): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const cfg = getCfg();
    const p = phrases(cfg.language);
    const short = toolName.startsWith(`mcp__${cfg.roblox.serverName}__`)
      ? toolName.slice(`mcp__${cfg.roblox.serverName}__`.length)
      : toolName;

    // Writing tools: code check, then the delete flag.
    if (CODE_TOOLS.includes(short)) {
      const code = extractCode(toolName, input);
      const verdict = checkLuau(code);
      if (!verdict.ok) {
        log("tool", `deny ${short}: ${verdict.reason}`);
        ev.onChildNotice(p.cannotDoThat);
        return { behavior: "deny", message: verdict.reason };
      }
      if (cfg.policy.askBeforeDelete && looksLikeDelete(code)) {
        ev.onChildNotice(p.askParent);
        const ok = await gate.ask(`Robo wants to delete something in the game (${short}). Allow?`, 60_000);
        log("tool", `${ok ? "allow" : "deny"} ${short} (delete, parent's decision)`);
        return ok ? { behavior: "allow" } : { behavior: "deny", message: "The parent did not allow deleting. Offer the child another option." };
      }
      log("tool", `allow ${short}`);
      return { behavior: "allow" };
    }

    if (GENERATE_TOOLS.includes(short)) {
      if (short === "search_asset") {
        // Free assets only. Studio's parameter name may differ; the server ignores an unknown key.
        const patched = { ...input, price: "free", free_only: true };
        return { behavior: "allow", updatedInput: patched };
      }
      if (cfg.policy.askBeforeGenerate) {
        ev.onChildNotice(p.askParent);
        const ok = await gate.ask(`Robo wants to generate or insert content (${short}). Allow?`, 60_000);
        log("tool", `${ok ? "allow" : "deny"} ${short} (generation, parent's decision)`);
        return ok ? { behavior: "allow" } : { behavior: "deny", message: "The parent did not allow it. Offer to build it from simple parts." };
      }
      log("tool", `allow ${short}`);
      return { behavior: "allow" };
    }

    // Anything else that reached this point is outside the allowlist.
    log("tool", `deny ${toolName}: outside the policy`);
    ev.onChildNotice(p.cannotDoThat);
    return { behavior: "deny", message: `The tool ${toolName} is not available in this mode.` };
  };
}

/** PreToolUse hook: the second line of defense, runs before rules and canUseTool. */
export function buildPreToolUseHooks(getCfg: () => Config): HookCallbackMatcher[] {
  const cfg = getCfg();
  const matcher = CODE_TOOLS.map((n) => tool(cfg, n)).join("|");
  return [
    {
      matcher,
      hooks: [
        async (input) => {
          if (input.hook_event_name !== "PreToolUse") return { continue: true };
          const code = extractCode(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
          const verdict = checkLuau(code);
          if (verdict.ok) return { continue: true };
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: verdict.reason,
            },
          };
        },
      ],
    },
  ];
}
