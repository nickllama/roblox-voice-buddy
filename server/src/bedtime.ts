/**
 * Bedtime by the family's local time (a parent setting, off by default): a warning at warnAt
 * ("in 15 minutes it is time for bed"), and at the bedtime Robo says good night and stops working
 * until wakeAt or until a parent presses Continue.
 *
 * Local time means the time zone set in the panel, not the PC's own zone, and the PC clock is
 * corrected against the internet (see clockOffset in index.ts): a child's PC is often set to the
 * wrong zone or drifts.
 *
 * A "night" is named by the date of its evening, so 01:00 belongs to the night that began the day
 * before. Each night warns once and puts Robo to bed once; a parent's Continue lets the child go on
 * for the rest of that night.
 */

export interface BedtimeConfig { enabled: boolean; warnAt: string; at: string; wakeAt: string; timeZone: string }

/** "20:15" into minutes after midnight; null when it is not a time. */
export function parseHM(v: string): number | null {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(v ?? "");
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** Local date and minutes after midnight in the zone (the PC's zone when it is empty or unknown). */
export function localClock(nowMs: number, timeZone: string): { day: string; minutes: number; hm: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = Number(get("hour")) % 24, minute = Number(get("minute"));
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: hour * 60 + minute, hm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

export function validTimeZone(tz: string): boolean {
  if (!tz) return true;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

export type BedtimeEvent = { kind: "warn"; minutesLeft: number } | { kind: "sleep"; msUntilWake: number } | null;

export class Bedtime {
  private warned = "";
  private slept = "";
  private allowed = "";

  /** What is due now. The caller confirms with markWarned / markSlept once it has acted, so a busy Robo can wait. */
  check(cfg: BedtimeConfig, nowMs: number): BedtimeEvent {
    if (!cfg.enabled) return null;
    const bed = parseHM(cfg.at), wake = parseHM(cfg.wakeAt) ?? 7 * 60, warn = parseHM(cfg.warnAt);
    if (bed === null) return null;
    const { minutes } = localClock(nowMs, cfg.timeZone);
    const night = this.night(cfg, nowMs, wake);
    const inNight = bed > wake ? minutes >= bed || minutes < wake : minutes >= bed && minutes < wake;
    if (inNight) {
      if (this.allowed === night || this.slept === night) return null;
      const left = (wake - minutes + 1440) % 1440;
      return { kind: "sleep", msUntilWake: left * 60_000 };
    }
    if (warn !== null && warn < bed && minutes >= warn && minutes < bed && this.warned !== night) return { kind: "warn", minutesLeft: bed - minutes };
    return null;
  }

  markWarned(cfg: BedtimeConfig, nowMs: number) { this.warned = this.night(cfg, nowMs); }
  markSlept(cfg: BedtimeConfig, nowMs: number) { this.slept = this.night(cfg, nowMs); }
  /** The parent let the child go on: no more bedtime this night. */
  allowTonight(cfg: BedtimeConfig, nowMs: number) { this.allowed = this.night(cfg, nowMs); }

  private night(cfg: BedtimeConfig, nowMs: number, wake = parseHM(cfg.wakeAt) ?? 7 * 60): string {
    return localClock(nowMs - wake * 60_000, cfg.timeZone).day;
  }
}
