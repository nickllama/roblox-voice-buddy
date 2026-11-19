import fs from "node:fs";

/**
 * Multiplication practice by voice, between game commands (off by default, a parent toggle).
 *
 * The cycle: after a command Robo teaches one fact ("Remember: 3 times 4 is 12. Next time I'll ask!").
 * After the next command it asks it. The child's next phrase is the answer: right earns a star and the
 * next fact is taught at once; wrong gets the right answer and the same fact is asked again later.
 * Every few stars Robo builds a small surprise in the game as the bonus.
 *
 * The server does all of this itself, without Claude: the lines are fixed phrases, the answer is
 * checked here, so it costs no tokens and cannot be forgotten when the Claude session restarts.
 * Progress is kept in workspace/math.json.
 *
 * Which fact comes next: a simple Leitner scheme. Every fact has a box 0..4; a right answer moves it
 * up, a wrong one back to 0. A fact in box n is asked again after INTERVALS[n] other questions.
 * Facts that are due come first, then new facts in table order, then the least known ones.
 */

export interface Fact { a: number; b: number }
interface FactState { box: number; due: number; right: number; wrong: number }
interface MathFile {
  facts: Record<string, FactState>;
  /** Questions asked so far; "due" counts in these. */
  asked: number;
  stars: number;
  /** taught: the fact was said, it will be asked after the next command. asked: Robo asked, the next phrase is the answer. */
  pending: { a: number; b: number; phase: "taught" | "asked"; skipped: number } | null;
}

/** Questions to wait before asking a fact again, by its box. Box 4 means learned. */
const INTERVALS = [1, 3, 6, 12, 25];
export const LEARNED_BOX = 3;
/** Multipliers practised for each table: ×1 and ×10 are too easy to be worth a question. */
const SECOND = [2, 3, 4, 5, 6, 7, 8, 9];
/** A question the child ignored this many times is dropped for now. */
const MAX_SKIPS = 2;

const key = (f: Fact) => `${f.a}x${f.b}`;

export type MathStep =
  /** Say this line at the end of the command's reply. */
  | { kind: "line"; line: "teach" | "ask"; fact: Fact }
  | { kind: "none" };

export interface Answer {
  right: boolean;
  fact: Fact;
  given: number;
  stars: number;
  /** A star count that earns the bonus surprise. */
  bonus: boolean;
  /** Fact to teach next (after a right answer). */
  next: Fact | null;
}

export class MathTrainer {
  private s: MathFile = { facts: {}, asked: 0, stars: 0, pending: null };

  constructor(private readonly file: string, public bonusEvery = 5) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as MathFile;
      if (raw && typeof raw.facts === "object") this.s = { facts: raw.facts, asked: raw.asked | 0, stars: raw.stars | 0, pending: raw.pending ?? null };
    } catch {}
  }

  private save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.s, null, 2)); } catch {}
  }

  /** Robo asked and is waiting for a number. */
  get expectsAnswer(): boolean { return this.s.pending?.phase === "asked"; }
  get stars(): number { return this.s.stars; }

  /** The next fact to teach from the given tables. */
  pick(tables: number[]): Fact | null {
    const all = tables.flatMap((a) => SECOND.map((b) => ({ a, b })));
    if (!all.length) return null;
    const st = (f: Fact) => this.s.facts[key(f)];
    const due = all.filter((f) => st(f) && st(f).box < 4 && st(f).due <= this.s.asked).sort((x, y) => st(x).box - st(y).box || st(x).due - st(y).due);
    if (due.length) return due[0];
    const fresh = all.find((f) => !st(f));
    if (fresh) return fresh;
    // Everything seen and nothing due: the least known one.
    return [...all].sort((x, y) => st(x).box - st(y).box || st(x).due - st(y).due)[0];
  }

  /**
   * A command reached Claude. Returns which line to say when its reply is done.
   * A pending question the child ignored is asked again, at most MAX_SKIPS times.
   */
  afterCommand(tables: number[]): MathStep {
    const p = this.s.pending;
    if (p?.phase === "taught") {
      p.phase = "asked";
      this.save();
      return { kind: "line", line: "ask", fact: { a: p.a, b: p.b } };
    }
    if (p?.phase === "asked") {
      // The child gave a command instead of an answer.
      p.skipped += 1;
      if (p.skipped <= MAX_SKIPS) { this.save(); return { kind: "line", line: "ask", fact: { a: p.a, b: p.b } }; }
      this.s.pending = null;
    }
    const f = this.pick(tables);
    if (!f) { this.save(); return { kind: "none" }; }
    this.s.pending = { ...f, phase: "taught", skipped: 0 };
    this.save();
    return { kind: "line", line: "teach", fact: f };
  }

  /** The child's phrase while a question is open. null: no number in it, so it is not an answer. */
  answer(text: string, tables: number[]): Answer | null {
    const p = this.s.pending;
    if (p?.phase !== "asked") return null;
    const given = lastNumber(text);
    if (given === null) return null;
    const fact = { a: p.a, b: p.b };
    const st = this.s.facts[key(fact)] ?? { box: 0, due: 0, right: 0, wrong: 0 };
    const right = given === fact.a * fact.b;
    this.s.asked += 1;
    if (right) { st.box = Math.min(4, st.box + 1); st.right += 1; this.s.stars += 1; }
    else { st.box = 0; st.wrong += 1; }
    st.due = this.s.asked + INTERVALS[st.box];
    this.s.facts[key(fact)] = st;
    let next: Fact | null = null;
    if (right) {
      next = this.pick(tables);
      this.s.pending = next ? { ...next, phase: "taught", skipped: 0 } : null;
    } else {
      this.s.pending = { ...fact, phase: "taught", skipped: 0 }; // the right answer was just said: ask it after the next command
    }
    this.save();
    const bonus = right && this.bonusEvery > 0 && this.s.stars % this.bonusEvery === 0;
    return { right, fact, given, stars: this.s.stars, bonus, next };
  }

  /** For the parent panel: stars and, per table, how many facts are learned. */
  progress(tables: number[]): { stars: number; tables: { table: number; learned: number; total: number }[] } {
    return {
      stars: this.s.stars,
      tables: tables.map((a) => ({ table: a, learned: SECOND.filter((b) => (this.s.facts[key({ a, b })]?.box ?? 0) >= LEARNED_BOX).length, total: SECOND.length })),
    };
  }
}

/** "2, 3, 5" from the panel into tables 2..10, sorted, without repeats. */
export function parseTables(v: unknown): number[] {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/[\s,;]+/);
  return [...new Set(list.map((x) => Math.round(Number(x))).filter((n) => n >= 2 && n <= 10))].sort((x, y) => x - y);
}

// ---------- numbers said aloud ----------

const WORDS: Record<string, number> = {
  ноль: 0, один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16,
  семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
  шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100,
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

/**
 * The last number in a phrase, written in digits or said in words (Russian or English, up to 100):
 * "сорок два" is 42, "three times four is twelve" is 12. The last one, because a child often repeats
 * the question before the answer. null when there is none.
 */
export function lastNumber(text: string): number | null {
  const tokens = text.toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const nums: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d+$/.test(t)) { nums.push(Number(t)); continue; }
    const v = WORDS[t];
    if (v === undefined) continue;
    const unit = WORDS[tokens[i + 1] ?? ""];
    // "сорок два", "forty two": a ten followed by a unit is one number.
    if (v >= 20 && v % 10 === 0 && v < 100 && unit !== undefined && unit >= 1 && unit <= 9) { nums.push(v + unit); i++; continue; }
    nums.push(v);
  }
  return nums.length ? nums[nums.length - 1] : null;
}

/** Words that may surround a bare answer: "это девять", "будет 12", "ответ: 9". The rest is a command. */
const FILLER = new Set([
  "это", "будет", "равно", "ответ", "наверное", "кажется", "мне", "думаю", "я", "ну", "а", "и", "умножить", "на", "раз", "сколько", "получается", "получится", "х",
  "is", "it", "its", "the", "answer", "equals", "maybe", "i", "think", "um", "uh", "times", "x", "multiplied", "by", "what",
]);

/** True when the phrase holds more than the answer: then it also goes to Claude as a command. */
export function hasCommand(text: string): boolean {
  const rest = text.toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}]+/u).filter((t) => t && !/^\d+$/.test(t) && WORDS[t] === undefined && !FILLER.has(t));
  return rest.length >= 2;
}
