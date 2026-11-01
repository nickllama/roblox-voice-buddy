import { phrases } from "../i18n.js";

/** Events the server sends to the page. */
export type RoboState = "idle" | "listen" | "think" | "build" | "speak" | "offline";

export type UiEvent =
  | { type: "state"; state: RoboState }
  | { type: "caption"; text: string }
  /** voiced: the audio for this sentence arrives separately as audio.* events; the page only shows the caption. */
  | { type: "speak"; text: string; id: number; voiced?: boolean }
  | { type: "speak.cancel" }
  | { type: "audio.begin"; id: number }
  | { type: "audio.chunk"; id: number; dataBase64: string }
  | { type: "audio.end"; id: number }
  | { type: "tool"; name: string }
  | { type: "notice"; text: string }
  | { type: "studio"; connected: boolean }
  | { type: "error"; text: string }
  | { type: "config"; stt: string; tts: string; hotkey: string; language: string; ttsVoiceMatch: string }
  | { type: "parent.ask"; id: number; question: string }
  | { type: "parent.update"; status: unknown }
  | { type: "parent.log"; entries: unknown[] };

/** Commands the page sends to the server. */
export type UiCommand =
  | { type: "ptt.down" }
  | { type: "ptt.up" }
  | { type: "utterance"; text: string }
  | { type: "stop" }
  | { type: "speak.done"; id: number }
  | { type: "stt.error"; code: string }
  /** The recording goes as binary WebSocket frames between audio.start and audio.stop. */
  | { type: "audio.start"; mime: string }
  | { type: "audio.stop" }
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
  | { type: "parent.update.apply" };

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
