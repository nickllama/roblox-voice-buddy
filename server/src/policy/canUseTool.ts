import type { CanUseTool, HookCallbackMatcher, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { checkLuau, extractCode, looksLikeDelete } from "./luauGuard.js";
import { CODE_TOOLS, GENERATE_TOOLS, tool } from "./rules.js";

/** Канал к родителю: вопрос, ответ в течение таймаута, иначе отказ. */
export interface ParentGate {
  ask(question: string, timeoutMs: number): Promise<boolean>;
}

export interface PolicyEvents {
  onChildNotice(text: string): void;
}

const DENY_CHILD = "Это я делать не умею, давай по-другому.";
const ASK_PARENT_CHILD = "Спроси маму или папу, можно ли.";

export function buildCanUseTool(getCfg: () => Config, gate: ParentGate, ev: PolicyEvents): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const cfg = getCfg();
    const short = toolName.startsWith(`mcp__${cfg.roblox.serverName}__`)
      ? toolName.slice(`mcp__${cfg.roblox.serverName}__`.length)
      : toolName;

    // Пишущие инструменты: проверка кода, затем удаление по флагу.
    if (CODE_TOOLS.includes(short)) {
      const code = extractCode(toolName, input);
      const verdict = checkLuau(code);
      if (!verdict.ok) {
        log("tool", `deny ${short}: ${verdict.reason}`);
        ev.onChildNotice(verdict.childText);
        return { behavior: "deny", message: verdict.reason };
      }
      if (cfg.policy.askBeforeDelete && looksLikeDelete(code)) {
        ev.onChildNotice(ASK_PARENT_CHILD);
        const ok = await gate.ask(`Робо хочет удалить что-то в игре (${short}). Разрешить?`, 60_000);
        log("tool", `${ok ? "allow" : "deny"} ${short} (удаление, решение родителя)`);
        return ok ? { behavior: "allow" } : { behavior: "deny", message: "Родитель не разрешил удалять. Предложи ребёнку другой вариант." };
      }
      log("tool", `allow ${short}`);
      return { behavior: "allow" };
    }

    if (GENERATE_TOOLS.includes(short)) {
      if (short === "search_asset") {
        // Только бесплатное. Имя параметра у Studio может отличаться, лишний ключ сервер проигнорирует.
        const patched = { ...input, price: "free", free_only: true };
        return { behavior: "allow", updatedInput: patched };
      }
      if (cfg.policy.askBeforeGenerate) {
        ev.onChildNotice(ASK_PARENT_CHILD);
        const ok = await gate.ask(`Робо хочет сгенерировать или вставить контент (${short}). Разрешить?`, 60_000);
        log("tool", `${ok ? "allow" : "deny"} ${short} (генерация, решение родителя)`);
        return ok ? { behavior: "allow" } : { behavior: "deny", message: "Родитель не разрешил. Предложи построить из простых деталей." };
      }
      log("tool", `allow ${short}`);
      return { behavior: "allow" };
    }

    // Всё остальное, что дошло сюда, не в списке разрешённого.
    log("tool", `deny ${toolName}: вне политики`);
    ev.onChildNotice(DENY_CHILD);
    return { behavior: "deny", message: `Инструмент ${toolName} недоступен в этом режиме.` };
  };
}

/** Хук PreToolUse: вторая линия защиты, срабатывает до правил и canUseTool. */
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
