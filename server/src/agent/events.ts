import { phrases } from "../i18n.js";

/** Events the server sends to the page. */
export type RoboState = "idle" | "listen" | "think" | "build" | "speak" | "offline";

export type UiEvent =
  | { type: "state"; state: RoboState }
  | { type: "caption"; text: string }
  /** voiced: the audio for this sentence arrives separately as audio.* events; the page only shows the caption. */
  | { type: "speak"; text: string; id: number; voiced?: boolean; test?: boolean }
  | { type: "speak.cancel" }
  | { type: "audio.begin"; id: number }
  | { type: "audio.chunk"; id: number; dataBase64: string }
  | { type: "audio.end"; id: number }
  | { type: "tool"; name: string }
  | { type: "notice"; text: string }
  | { type: "studio"; connected: boolean }
  | { type: "error"; text: string }
  | { type: "config"; stt: string; tts: string; hotkey: string; language: string; ttsVoiceMatch: string }
  /** The parent pressed "Test recognition": the child's page listens for a few seconds and reports back. */
  | { type: "stt.test" }
  | { type: "parent.ask"; id: number; question: string }
  | { type: "parent.update"; status: unknown }
  | { type: "parent.health"; health: Health }
  | { type: "parent.log"; entries: unknown[] };

/** What the parent panel shows as "Health": each item is plain data, the panel renders the words. */
export interface Health {
  claude: { loggedIn: boolean; method: string } | null;
  /** mcp.bat present; null outside Windows. */
  studioLauncher: boolean | null;
  /** Direct probe of the launcher (list_roblox_studios), refreshed at start and periodically. */
  studio: { connected: boolean; detail: string; at: number } | null;
  /** From the SDK init message; null until the first request. */
  studioSession: boolean | null;
  /** Summary of the last browser self-check. */
  browser: string | null;
  sttError: { code: string; hint: string; at: number } | null;
  /** bytes/level/audioSeconds are filled for server-side recognition (Deepgram); they tell a silent mic from a failed service. */
  sttTest: { text: string; at: number; bytes?: number; level?: number; audioSeconds?: number | null } | null;
  sttProvider: string;
  ttsProvider: string;
  ttsError: { code: string; voice: string | null; hint: string; at: number } | null;
  ttsTest: { ok: boolean; voice: string | null; ms: number; error: string | null; at: number } | null;
}

/** Commands the page sends to the server. */
export type UiCommand =
  | { type: "ptt.down" }
  | { type: "ptt.up" }
  | { type: "utterance"; text: string }
  | { type: "stop" }
  | { type: "speak.done"; id: number }
  | { type: "stt.error"; code: string }
  /** The recording goes as binary WebSocket frames between audio.start and audio.stop. */
  | { type: "audio.start"; mime: string; test?: boolean }
  /** level: peak microphone amplitude 0..1 measured by the page during the recording. */
  | { type: "audio.stop"; level?: number }
  /** Result of a recognition test started from the parent panel; never goes to Claude. */
  | { type: "stt.result"; text: string }
  /** A browser or server utterance failed to play. */
  | { type: "tts.error"; code: string; voice: string | null }
  /** Result of "Test voice" from the parent panel. */
  | { type: "tts.result"; ok: boolean; voice: string | null; ms: number; error: string | null }
  /** Browser self-check sent once per page load: what the page can do for the configured language. */
  | { type: "diag"; speechRecognition: boolean; mediaRecorder: boolean; mse: boolean; voices: string[]; voicesTotal: number }
  | { type: "parent.auth"; pin: string }
  | { type: "parent.say"; text: string }
  | { type: "parent.answer"; id: number; ok: boolean }
  | { type: "parent.reset" }
  | { type: "parent.prompt.get" }
  | { type: "parent.prompt.set"; text: string }
  | { type: "parent.config.get" }
  | { type: "parent.config.set"; patch: Record<string, unknown> }
  | { type: "parent.log.get" }
  | { type: "parent.update.check" }
  | { type: "parent.update.apply" }
  | { type: "parent.health.get" }
  | { type: "parent.test.tts" }
  | { type: "parent.test.stt" };

/** Cuts a text stream into sentences for speech. */
export class SentenceSplitter {
  private buf = "";
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    // Sentence boundary: . ! ? … and a newline, followed by whitespace or the end.
    const re = /([^.!?…\n]*[.!?…]+["»)]?)(\s+|$)|([^\n]+)\n/g;
    let m: RegExpExecArray | null;
    let last = 0;
    while ((m = re.exec(this.buf)) !== null) {
      const s = (m[1] ?? m[3] ?? "").trim();
      if (m.index + m[0].length === this.buf.length && !/[.!?…\n]\s*$/.test(this.buf) && m[3] === undefined) break;
      if (s) out.push(s);
      last = m.index + m[0].length;
    }
    this.buf = this.buf.slice(last);
    return out;
  }
  flush(): string[] {
    const s = this.buf.trim();
    this.buf = "";
    return s ? [s] : [];
  }
}

/** Removes everything that must not be read aloud to a child. Replacement words depend on the language. */
export function cleanForSpeech(text: string, language = "en"): string {
  const p = phrases(language);
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*|__|\*|_/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\bgame\.[A-Za-z0-9_.]+/g, p.objectWord)
    .replace(/\bmcp__[A-Za-z0-9_]+/g, p.toolWord)
    .replace(/\s{2,}/g, " ")
    .trim();
}
