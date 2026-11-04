import fs from "node:fs";
import path from "node:path";
import type { UsageTotals } from "./agent/events.js";

/** One calendar day (local time) of the child's activity, kept across restarts in workspace/stats.json. */
export interface DayStats {
  /** YYYY-MM-DD in local time. */
  date: string;
  /** Commands the child gave (utterances that reached Claude or were answered by Robo itself). */
  commands: number;
  /** Claude requests that finished, and the agent steps inside them. */
  requests: number;
  steps: number;
  /** Time the child spent with Robo: gaps between activity shorter than the idle limit are counted, long gaps are not. */
  playMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  breaks: number;
  firstAt: number | null;
  lastAt: number | null;
}

interface StatsFile {
  days: Record<string, DayStats>;
}

/** The idle limit: a gap longer than this between two activities means the child was away, so it is not play time. */
export const IDLE_LIMIT_MS = 10 * 60_000;

function emptyDay(date: string): DayStats {
  return { date, commands: 0, requests: 0, steps: 0, playMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, breaks: 0, firstAt: null, lastAt: null };
}

export function dayKey(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Daily counters for the parent: how long the child sat with Robo, how many commands, how many tokens.
 * Usage comes from the session's running totals (the SDK sums them since the server started), so the
 * difference against the last snapshot is what gets added to the day.
 */
export class DailyStats {
  private days: Record<string, DayStats> = {};
  private lastActivity: number | null = null;
  private seen = { requests: 0, turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };

  constructor(private readonly file: string, private readonly now: () => number = Date.now, private readonly idleMs = IDLE_LIMIT_MS) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as StatsFile;
      if (raw && typeof raw.days === "object" && raw.days) this.days = raw.days;
    } catch {
      this.days = {};
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ days: this.days } satisfies StatsFile, null, 2));
    } catch {
      // Stats are a convenience; a failed write must not stop Robo.
    }
  }

  private today(at: number): DayStats {
    const key = dayKey(at);
    return (this.days[key] ??= emptyDay(key));
  }

  /** Marks the child as present now: the time since the previous activity counts as play if it was short. */
  private activity(at: number): DayStats {
    const day = this.today(at);
    if (this.lastActivity !== null) {
      const gap = at - this.lastActivity;
      if (gap > 0 && gap <= this.idleMs && dayKey(this.lastActivity) === day.date) day.playMs += gap;
    }
    this.lastActivity = at;
    day.firstAt ??= at;
    day.lastAt = at;
    return day;
  }

  /** The child gave a command. */
  command(): void {
    const day = this.activity(this.now());
    day.commands += 1;
    this.save();
  }

  /** A break started (by the timer or the parent). */
  breakStarted(): void {
    this.today(this.now()).breaks += 1;
    this.save();
  }

  /** Called whenever the session's running totals may have grown; adds the difference to today. */
  syncUsage(u: UsageTotals): void {
    const tokensIn = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    const d = {
      requests: u.requests - this.seen.requests,
      turns: u.turns - this.seen.turns,
      tokensIn: tokensIn - this.seen.tokensIn,
      tokensOut: u.outputTokens - this.seen.tokensOut,
      costUsd: u.costUsd - this.seen.costUsd,
    };
    this.seen = { requests: u.requests, turns: u.turns, tokensIn, tokensOut: u.outputTokens, costUsd: u.costUsd };
    if (d.requests <= 0 && d.tokensIn <= 0 && d.tokensOut <= 0) return;
    const day = this.activity(this.now());
    day.requests += Math.max(0, d.requests);
    day.steps += Math.max(0, d.turns);
    day.tokensIn += Math.max(0, d.tokensIn);
    day.tokensOut += Math.max(0, d.tokensOut);
    day.costUsd += Math.max(0, d.costUsd);
    this.save();
  }

  /** The last `n` days that have any record, newest first. */
  recent(n = 14): DayStats[] {
    return Object.values(this.days).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, n);
  }
}
