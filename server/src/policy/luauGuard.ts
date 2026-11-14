/**
 * Checks Luau code and script edits before they run.
 * The tool allowlist does not limit what the code inside execute_luau does,
 * so dangerous services are cut off here.
 */

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

export interface GuardOptions {
  /** The parent turned on "save player progress": plain DataStore reads and writes are let through. */
  saveProgress?: boolean;
}

type Rule = { re: RegExp; reason: string };

/** Saving is off (the default): every data store service is cut off. */
const DATASTORE_OFF: Rule = {
  re: /DataStoreService|OrderedDataStore|MemoryStoreService/i,
  reason: "saving player data (DataStore) is turned off; a grown-up can turn on \"save player progress\" in Robo's parent panel",
};
/** Saving is on: get/set/update of a regular data store pass; deleting, listing, ordered and memory stores do not. */
const DATASTORE_ON: Rule = {
  re: /OrderedDataStore|MemoryStoreService|ListDataStoresAsync|ListKeysAsync|ListVersionsAsync|RemoveAsync|RemoveVersionAsync/i,
  reason: "only plain saving and loading of game progress is allowed: no deleting or listing saved data, no ordered or memory stores",
};
/** GetAsync( is also how a data store reads, so with saving on only the HTTP names themselves are matched. */
const HTTP_OFF: Rule = { re: /HttpService|HttpRbxApiService|RequestAsync|PostAsync|GetAsync\s*\(/i, reason: "internet requests (HttpService) are not allowed" };
const HTTP_ON: Rule = { re: /HttpService|HttpRbxApiService|RequestAsync|PostAsync|HttpEnabled/i, reason: "internet requests (HttpService) are not allowed" };

const BANNED: Rule[] = [
  { re: /MarketplaceService|PromptPurchase|PromptProductPurchase|GamePassService|PolicyService/i, reason: "purchases and paid items are not allowed" },
  { re: /TeleportService/i, reason: "teleports to other games are not allowed" },
  { re: /PublishService|SavePlaceAsync|PublishToRoblox|StudioService.*Publish|PublishAsync/i, reason: "publishing and saving to the cloud are not allowed" },
  { re: /MessagingService/i, reason: "cross-server messaging is not allowed" },
  { re: /AssetService.*(Create|Save|Publish)|CreatePlaceAsync|SavePlaceAsync/i, reason: "creating places and assets is not allowed" },
  { re: /:Kick\s*\(/i, reason: "kicking players is not allowed" },
  { re: /\brequire\s*\(\s*\d{5,}\s*\)/i, reason: "loading someone else's code by asset id is not allowed" },
  { re: /loadstring|getfenv|setfenv/i, reason: "running arbitrary code is not allowed" },
  { re: /game\.Workspace\s*:\s*ClearAllChildren|workspace\s*:\s*ClearAllChildren|game\s*:\s*ClearAllChildren/i, reason: "deleting the whole world is not allowed" },
  { re: /plugin\s*:\s*|PluginManager|ScriptEditorService|StudioService|CoreGui|RobloxPluginGuiService/i, reason: "commands to Studio itself are not allowed" },
  { re: /InsertService|LoadAsset\s*\(/i, reason: "inserting assets from code is not allowed, there is a separate tool" },
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

/** The reason goes back to Claude as the tool result; Claude then explains it to the child in the child's language. */
export function checkLuau(code: string, opts: GuardOptions = {}): GuardVerdict {
  const rules = opts.saveProgress ? [DATASTORE_ON, HTTP_ON, ...BANNED] : [DATASTORE_OFF, HTTP_OFF, ...BANNED];
  for (const { re, reason } of rules) {
    if (re.test(code)) {
      return {
        ok: false,
        reason: `Robo: ${reason}. Do the same thing another way, or explain to the child in simple words why this is not allowed.`,
      };
    }
  }
  return { ok: true };
}

export function looksLikeDelete(code: string): boolean {
  return DELETE_RE.test(code);
}
