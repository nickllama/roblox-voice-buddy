import { log } from "./log.js";

type Handler = (down: boolean) => void;

/**
 * Global push-to-talk key via uiohook-napi.
 * The module is native; on a machine without a build it may fail to load, then only the on-screen button remains.
 */
export async function startHotkey(keyName: string, onKey: Handler): Promise<() => void> {
  // The native hook crashes without a graphical session (Linux without X11), and it is only needed on Windows.
  if (process.platform !== "win32" && !process.env.ROBO_HOTKEY) {
    log("system", "hotkey off: not Windows (ROBO_HOTKEY=1 forces it on)");
    return () => {};
  }
  try {
    const mod = await import("uiohook-napi");
    const { uIOhook, UiohookKey } = mod;
    const code = (UiohookKey as Record<string, number>)[keyName];
    if (code === undefined) {
      log("error", `unknown hotkey: ${keyName}`);
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
    log("system", `hotkey ${keyName} on`);
    return () => uIOhook.stop();
  } catch (e) {
    log("error", `hotkey unavailable: ${String(e)}`);
    return () => {};
  }
}
