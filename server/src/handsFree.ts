/**
 * Hands-free mode: the microphone stays open and Robo decides from the recognized text whether
 * the child is talking to it. Asleep, only the wake phrase ("Robo, hello") is acted on and
 * everything else is dropped. Awake, every phrase is a command until the stop phrase
 * ("Stop, Robo") or until nothing has happened for a while.
 *
 * Words of both languages are accepted whatever config.language says: recognition spells the
 * name in several ways, and a wrong guess costs nothing.
 */

/** How recognition spells "Robo". */
const NAMES = new Set(["robo", "robot", "robbo", "rowbo", "roebo", "робо", "роба", "рабо", "робот", "робу"]);
const GREETINGS = new Set(["hey", "hi", "hello", "привет", "приветик", "здравствуй"]);
const STOPS = new Set(["stop", "bye", "goodbye", "стоп", "пока"]);
/** "Robo, stop" as a whole phrase; a longer sentence that merely contains the words is a command. */
const STOP_MAX_WORDS = 3;

export type Heard =
  /** Asleep and not addressed to Robo. nearMiss: half of the wake phrase was there (the name or the greeting). */
  | { kind: "ignore"; nearMiss: boolean }
  /** The wake phrase. rest: what the child said after it in the same breath, possibly empty. */
  | { kind: "wake"; rest: string }
  /** The stop phrase while awake. */
  | { kind: "sleep" }
  /** Awake: an ordinary phrase for Robo. */
  | { kind: "command"; text: string }
  /** Robo's own words coming back through the microphone (speakers, room echo, a slow Bluetooth speaker). */
  | { kind: "echo" };

/** How long after Robo said something its words may still come back from the speakers. */
const ECHO_MS = 20_000;
/** Share of the heard words (3+ letters) that Robo itself just said, from which a phrase counts as echo. */
const ECHO_SHARE = 0.6;

const norm = (w: string) => w.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");

export class HandsFree {
  awake = false;
  private last = 0;
  private spoken: { words: string[]; at: number }[] = [];

  constructor(private now: () => number = Date.now) {}

  /** A phrase the microphone heard. Changes awake and returns what to do with the phrase. */
  hear(text: string): Heard {
    const words = text.split(/\s+/).filter((w) => norm(w));
    const n = words.map(norm);
    const name = n.findIndex((w) => NAMES.has(w));

    if (this.awake && this.isSleepPhrase(text)) {
      this.awake = false;
      return { kind: "sleep" };
    }

    if (this.isEcho(n)) return { kind: "echo" };

    // The name and a greeting side by side, in either order.
    let end = -1;
    for (let i = 0; i < n.length && end < 0; i++) {
      if (!NAMES.has(n[i])) continue;
      if (GREETINGS.has(n[i + 1] ?? "")) end = i + 1;
      else if (GREETINGS.has(n[i - 1] ?? "")) end = i;
    }
    if (end >= 0) {
      this.awake = true;
      this.touch();
      return { kind: "wake", rest: words.slice(end + 1).join(" ") };
    }

    if (!this.awake) return { kind: "ignore", nearMiss: name >= 0 || n.some((w) => GREETINGS.has(w)) };
    return { kind: "command", text: words.join(" ") };
  }

  /** "Stop, Robo" / "Robo, bye": the name plus a stop word, nothing more. */
  isSleepPhrase(text: string): boolean {
    const n = text.split(/\s+/).map(norm).filter(Boolean);
    return n.some((w) => NAMES.has(w)) && n.length <= STOP_MAX_WORDS && n.some((w) => STOPS.has(w));
  }

  /** Robo said this (a reply sentence or a system phrase): if the microphone hears it back, it is not a command. */
  said(text: string) {
    const words = text.split(/\s+/).map(norm).filter((w) => w.length >= 3);
    if (!words.length) return;
    const now = this.now();
    this.spoken = this.spoken.filter((s) => now - s.at < ECHO_MS).slice(-20);
    this.spoken.push({ words, at: now });
  }

  private isEcho(heard: string[]): boolean {
    const now = this.now();
    const recent = new Set(this.spoken.filter((s) => now - s.at < ECHO_MS).flatMap((s) => s.words));
    if (!recent.size) return false;
    const long = heard.filter((w) => w.length >= 3);
    // A single word is never taken for echo: it may be the answer to Robo's question ("nine").
    if (long.length < 2) return false;
    return long.filter((w) => recent.has(w)).length / long.length >= ECHO_SHARE;
  }

  /** Something happened that keeps the conversation going: a command, or Robo finished a reply. */
  touch() { this.last = this.now(); }

  /** Falls asleep after idleMs without activity. Returns true when it just fell asleep. */
  sleepIfIdle(idleMs: number): boolean {
    if (!this.awake || idleMs <= 0 || this.now() - this.last < idleMs) return false;
    this.awake = false;
    return true;
  }

  sleep() { this.awake = false; }
}
