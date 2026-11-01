import { cleanForSpeech } from "../agent/events.js";

/**
 * Cleans text for speech as it arrives from Claude, without waiting for the end of a sentence.
 * Emits whole words only (a trailing partial word waits for the next delta), drops code inside
 * ``` and `, and runs the rest through cleanForSpeech. Every emitted piece ends with a space,
 * as the ElevenLabs streaming input requires.
 */
export class StreamCleaner {
  private buf = "";
  private inFence = false;

  constructor(private language = "en") {}

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (;;) {
      if (this.inFence) {
        const close = this.buf.indexOf("```");
        if (close < 0) { this.buf = this.buf.slice(-2); return out; } // the closing ``` may arrive in pieces
        this.buf = this.buf.slice(close + 3);
        this.inFence = false;
        continue;
      }
      const open = this.buf.indexOf("```");
      if (open >= 0) {
        out += this.emit(this.buf.slice(0, open));
        this.buf = this.buf.slice(open + 3);
        this.inFence = true;
        continue;
      }
      // An unclosed single backtick: wait for its pair, but not longer than 80 characters.
      const ticks = (this.buf.match(/`/g) ?? []).length;
      if (ticks % 2 === 1 && this.buf.length - this.buf.lastIndexOf("`") < 80) return out;
      // A finished sentence goes out whole, otherwise everything up to the last whitespace.
      if (/[.!?…]["»)]?\s*$/.test(this.buf)) {
        out += this.emit(this.buf);
        this.buf = "";
        return out;
      }
      const idx = this.buf.search(/\s\S*$/);
      if (idx < 0) return out;
      out += this.emit(this.buf.slice(0, idx + 1));
      this.buf = this.buf.slice(idx + 1);
      return out;
    }
  }

  /** Returns what is left (for example the last word without a period). */
  flush(): string {
    const rest = this.inFence ? "" : this.emit(this.buf);
    this.buf = "";
    this.inFence = false;
    return rest;
  }

  private emit(raw: string): string {
    const clean = cleanForSpeech(raw, this.language);
    return clean ? clean + " " : "";
  }
}
