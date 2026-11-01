import { log } from "./log.js";

type Handler = (down: boolean) => void;

/**
 * Глобальная клавиша push-to-talk через uiohook-napi.
 * Модуль нативный, на машине без сборки может не загрузиться, тогда остаётся экранная кнопка.
 */
export async function startHotkey(keyName: string, onKey: Handler): Promise<() => void> {
  // Нативный хук падает без графической сессии (Linux без X11), а нужен он только на Windows.
  if (process.platform !== "win32" && !process.env.ROBO_HOTKEY) {
    log("system", "хоткей выключен: не Windows (ROBO_HOTKEY=1 включает принудительно)");
    return () => {};
  }
  try {
    const mod = await import("uiohook-napi");
    const { uIOhook, UiohookKey } = mod;
    const code = (UiohookKey as Record<string, number>)[keyName];
    if (code === undefined) {
      log("error", `неизвестная клавиша хоткея: ${keyName}`);
      return () => {};
    }
    let pressed = false;
    uIOhook.on("keydown", (e) => {
      if (e.keycode === code && !pressed) { pressed = true; onKey(true); }
    });
    uIOhook.on("keyup", (e) => {
      if (e.keycode === code && pressed) { pressed = false; onKey(false); }
    });
    uIOhook.start();
    log("system", `хоткей ${keyName} включён`);
    return () => uIOhook.stop();
  } catch (e) {
    log("error", `хоткей недоступен: ${String(e)}`);
    return () => {};
  }
}
