// Calibration — the part of stasis that learns from YOU.
//
// The route's token estimates are already grounded in reality (a project's block
// cost is the median of its real daily output). What was NOT grounded is the
// tokens→minutes conversion: it used a hardcoded 1500 tok/min, so every "~100m"
// the tool printed was a guess dressed as a number.
//
// This measures your actual throughput from usage timestamps. Active time is the
// sum of gaps between consecutive events, each capped at an idle threshold — so
// a lunch break doesn't count as work, but thinking pauses do.
import type { UsageEvent } from "../adapters/usage.ts";

const DAY_MS = 86_400_000;
/** A gap longer than this means you walked away — don't count it as work. */
const IDLE_GAP_MS = 5 * 60_000;
/** Fallback when there isn't enough history to measure honestly. */
export const DEFAULT_TOKENS_PER_MIN = 1500;
/** A day must be this substantial to say anything about your rate. */
const MIN_DAY_TOKENS = 20_000;
const MIN_DAY_MINUTES = 10;
/** Below this many qualifying days we don't claim to know your rate. */
const MIN_SAMPLES = 3;
/** Guard rails: a measured rate outside this band is noise, not signal. */
const RATE_MIN = 200;
const RATE_MAX = 10_000;

export interface RateStats {
  /** Output tokens per minute of active work. */
  rate: number;
  /** True when measured from your own history; false = the default guess. */
  measured: boolean;
  /** Qualifying days behind the measurement. */
  samples: number;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Milliseconds of active work represented by a set of event timestamps: the sum
 * of consecutive gaps, each capped at IDLE_GAP_MS. A lone event counts as a
 * minute (it took *some* time), never zero — that would divide by zero later.
 */
export function activeMs(timestamps: number[]): number {
  if (timestamps.length === 0) return 0;
  if (timestamps.length === 1) return 60_000;
  const s = [...timestamps].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < s.length; i++) {
    const gap = s[i]! - s[i - 1]!;
    if (gap > 0) total += Math.min(gap, IDLE_GAP_MS);
  }
  return Math.max(total, 60_000);
}

/**
 * Your real output-tokens-per-minute, measured per day and taken as a median so
 * one marathon session can't skew it. Falls back to the documented default when
 * there aren't enough substantial days to be honest about.
 */
export function measureTokensPerMin(events: UsageEvent[]): RateStats {
  const byDay = new Map<number, { ts: number[]; tokens: number }>();
  for (const e of events) {
    if (e.outputTokens <= 0) continue;
    const day = Math.floor(e.ts / DAY_MS);
    const bucket = byDay.get(day) ?? { ts: [], tokens: 0 };
    bucket.ts.push(e.ts);
    bucket.tokens += e.outputTokens;
    byDay.set(day, bucket);
  }

  const rates: number[] = [];
  for (const { ts, tokens } of byDay.values()) {
    if (tokens < MIN_DAY_TOKENS) continue;
    const minutes = activeMs(ts) / 60_000;
    if (minutes < MIN_DAY_MINUTES) continue;
    rates.push(tokens / minutes);
  }

  if (rates.length < MIN_SAMPLES) {
    return { rate: DEFAULT_TOKENS_PER_MIN, measured: false, samples: rates.length };
  }
  const raw = median(rates);
  const rate = Math.round(Math.max(RATE_MIN, Math.min(RATE_MAX, raw)));
  return { rate, measured: true, samples: rates.length };
}
