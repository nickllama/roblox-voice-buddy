/**
 * Проверка Luau-кода и правок скриптов до выполнения.
 * Список разрешённых инструментов не ограничивает, что делает код внутри
 * execute_luau, поэтому опасные сервисы отсекаются здесь.
 */

export type GuardVerdict = { ok: true } | { ok: false; reason: string; childText: string };

const BANNED: Array<{ re: RegExp; reason: string }> = [
  { re: /DataStoreService|OrderedDataStore|MemoryStoreService/i, reason: "сохранение данных игроков (DataStore) запрещено" },
  { re: /HttpService|HttpRbxApiService|RequestAsync|GetAsync\s*\(/i, reason: "запросы в интернет (HttpService) запрещены" },
  { re: /MarketplaceService|PromptPurchase|PromptProductPurchase|GamePassService|PolicyService/i, reason: "покупки и платные вещи запрещены" },
  { re: /TeleportService/i, reason: "телепорты в другие игры запрещены" },
  { re: /PublishService|SavePlaceAsync|PublishToRoblox|StudioService.*Publish|PublishAsync/i, reason: "публикация и сохранение в облако запрещены" },
  { re: /MessagingService/i, reason: "сообщения между серверами запрещены" },
  { re: /AssetService.*(Create|Save|Publish)|CreatePlaceAsync|SavePlaceAsync/i, reason: "создание мест и ассетов запрещено" },
  { re: /:Kick\s*\(/i, reason: "выкидывать игроков запрещено" },
  { re: /\brequire\s*\(\s*\d{5,}\s*\)/i, reason: "загрузка чужого кода по номеру запрещена" },
  { re: /loadstring|getfenv|setfenv/i, reason: "выполнение произвольного кода запрещено" },
  { re: /game\.Workspace\s*:\s*ClearAllChildren|workspace\s*:\s*ClearAllChildren|game\s*:\s*ClearAllChildren/i, reason: "удаление всего мира запрещено" },
  { re: /plugin\s*:\s*|PluginManager|ScriptEditorService|StudioService|CoreGui|RobloxPluginGuiService/i, reason: "команды для самой Studio запрещены" },
  { re: /InsertService|LoadAsset\s*\(/i, reason: "вставка ассетов через код запрещена, есть отдельный инструмент" },
];

const DELETE_RE = /:\s*Destroy\s*\(|:\s*Remove\s*\(|\.Parent\s*=\s*nil|ClearAllChildren/i;

export function extractCode(toolName: string, input: Record<string, unknown>): string {
  if (toolName.endsWith("execute_luau")) {
    for (const k of ["code", "script", "source", "luau"]) {
      const v = input[k];
      if (typeof v === "string") return v;
    }
    return JSON.stringify(input);
  }
  if (toolName.endsWith("multi_edit")) {
    const edits = input["edits"];
    if (Array.isArray(edits)) {
      return edits
        .map((e) => (e && typeof e === "object" ? Object.values(e as Record<string, unknown>).filter((x) => typeof x === "string").join("\n") : ""))
        .join("\n");
    }
    return JSON.stringify(input);
  }
  return "";
}

export function checkLuau(code: string): GuardVerdict {
  for (const { re, reason } of BANNED) {
    if (re.test(code)) {
      return {
        ok: false,
        reason: `Робо: ${reason}. Сделай то же самое другим способом или объясни ребёнку простыми словами, почему так нельзя.`,
        childText: "Это я делать не умею, давай по-другому.",
      };
    }
  }
  return { ok: true };
}

export function looksLikeDelete(code: string): boolean {
  return DELETE_RE.test(code);
}
