// Subscription burn, measured honestly. Anthropic does not publish Max/Pro caps
// in tokens, so we do NOT invent them. Instead: you read your real % from
// Claude Code's `/usage` once, and `stasis quota --set` derives YOUR personal
// cap from measured burn (cap = tokens_so_far / (pct/100)). Logs then extrapolate
// forward. Until calibrated, we show raw burn and no fake percentage.
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Subscription } from "../types.ts";
import type { UsageEvent } from "../adapters/usage.ts";
import { STASIS_DIR } from "../config.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CALIB_PATH = join(STASIS_DIR, "quota-state.json");

export type GateLevel = "green" | "yellow" | "red";

/** Personal caps (output tokens) derived from a real /usage reading. */
export interface QuotaCalib {
  at: string; // ISO timestamp of the reading
  weekCap?: number; // output tokens ≈ 100% of the weekly cap
  fiveHCap?: number; // output tokens ≈ 100% of the 5h cap
}

export interface WindowBurn {
  tokens: number; // output tokens in the window
  cap: number | null;
  pct: number | null; // 0..1, null if uncalibrated
}

export interface QuotaStatus {
  subscription: string;
  calibrated: boolean;
  rolling5h: WindowBurn;
  weekly: WindowBurn;
  resetInDays: number;
  gate: GateLevel;
}

export function loadCalib(): QuotaCalib | null {
  try {
    if (!existsSync(CALIB_PATH)) return null;
    return JSON.parse(readFileSync(CALIB_PATH, "utf8")) as QuotaCalib;
  } catch {
    return null;
  }
}

export function saveCalib(c: QuotaCalib): void {
  writeFileSync(CALIB_PATH, JSON.stringify(c, null, 2) + "\n");
}

/** Start-of-day (local) for the most recent given weekday, inclusive of today. */
function lastResetMs(resetDay: string, now: number): number {
  const target = WEEKDAYS.indexOf(resetDay);
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const idx = target >= 0 ? target : 1;
  const back = (d.getDay() - idx + 7) % 7;
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** Output tokens in [sinceMs, untilMs]. */
export function outputBetween(events: UsageEvent[], sinceMs: number, untilMs = Infinity): number {
  let t = 0;
  for (const e of events) if (e.ts >= sinceMs && e.ts <= untilMs) t += e.outputTokens;
  return t;
}

/**
 * Derive personal caps from a real /usage reading (percentages 0..100).
 * cap = tokens_in_window_so_far / (pct/100). Needs current-window burn from logs.
 */
export function calibrate(
  events: UsageEvent[],
  reading: { week?: number; fiveH?: number },
  resetDay: string,
  now = Date.now(),
): QuotaCalib {
  const calib: QuotaCalib = { at: new Date(now).toISOString() };
  if (reading.week && reading.week > 0) {
    const weekOut = outputBetween(events, lastResetMs(resetDay, now), now);
    if (weekOut > 0) calib.weekCap = Math.round(weekOut / (reading.week / 100));
  }
  if (reading.fiveH && reading.fiveH > 0) {
    const fiveHOut = outputBetween(events, now - 5 * HOUR_MS, now);
    if (fiveHOut > 0) calib.fiveHCap = Math.round(fiveHOut / (reading.fiveH / 100));
  }
  return calib;
}

function pctOf(tokens: number, cap: number | null): number | null {
  if (cap == null || cap <= 0) return null;
  return tokens / cap;
}

function gateFrom(pcts: Array<number | null>): GateLevel {
  const known = pcts.filter((p): p is number => p != null);
  if (known.length === 0) return "green"; // uncalibrated → don't fabricate constraint
  const worst = Math.max(...known);
  if (worst >= 0.85) return "red";
  if (worst >= 0.6) return "yellow";
  return "green";
}

export function computeQuota(
  subs: Subscription[],
  events: UsageEvent[],
  calib: QuotaCalib | null,
  now = Date.now(),
): QuotaStatus[] {
  return subs.map((s) => {
    const roll = outputBetween(events, now - 5 * HOUR_MS, now);
    const resetMs = lastResetMs(s.resetDay, now);
    const week = outputBetween(events, resetMs, now);

    const weekCap = calib?.weekCap ?? s.weeklyTokenCap ?? null;
    const fiveHCap = calib?.fiveHCap ?? s.rolling5hTokenCap ?? null;

    const rolling5h: WindowBurn = { tokens: roll, cap: fiveHCap, pct: pctOf(roll, fiveHCap) };
    const weekly: WindowBurn = { tokens: week, cap: weekCap, pct: pctOf(week, weekCap) };

    const nextReset = resetMs + 7 * DAY_MS;
    const resetInDays = Math.max(0, Math.ceil((nextReset - now) / DAY_MS));

    return {
      subscription: s.name,
      calibrated: calib?.weekCap != null || calib?.fiveHCap != null,
      rolling5h,
      weekly,
      resetInDays,
      gate: gateFrom([rolling5h.pct, weekly.pct]),
    };
  });
}

export function overallGate(statuses: QuotaStatus[]): GateLevel {
  if (statuses.some((s) => s.gate === "red")) return "red";
  if (statuses.some((s) => s.gate === "yellow")) return "yellow";
  return "green";
}
