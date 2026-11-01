import { cleanForSpeech } from "../agent/events.js";

/**
 * Чистит текст для озвучки по мере прихода от Claude, не дожидаясь конца предложения.
 * Выдаёт только целые слова (хвост без пробела ждёт следующей порции), код внутри ``` и `
 * не пропускает, остальное прогоняет через cleanForSpeech. Каждая порция на выходе
 * заканчивается пробелом: так требует потоковый вход ElevenLabs.
 */
export class StreamCleaner {
  private buf = "";
  private inFence = false;

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (;;) {
      if (this.inFence) {
        const close = this.buf.indexOf("```");
        if (close < 0) { this.buf = this.buf.slice(-2); return out; } // закрывающие ``` могут прийти по частям
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
      // Незакрытый одиночный backtick: ждём пару, но не дольше 80 символов.
      const ticks = (this.buf.match(/`/g) ?? []).length;
      if (ticks % 2 === 1 && this.buf.length - this.buf.lastIndexOf("`") < 80) return out;
      // Конец предложения отдаём целиком, иначе всё до последнего пробела.
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

  /** Отдаёт остаток (например, последнее слово без точки). */
  flush(): string {
    const rest = this.inFence ? "" : this.emit(this.buf);
    this.buf = "";
    this.inFence = false;
    return rest;
  }

  private emit(raw: string): string {
    const clean = cleanForSpeech(raw);
    return clean ? clean + " " : "";
  }
}
