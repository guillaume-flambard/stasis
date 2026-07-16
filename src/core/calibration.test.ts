import { describe, test, expect } from "bun:test";
import { activeMs, measureTokensPerMin, DEFAULT_TOKENS_PER_MIN } from "./calibration.ts";
import type { UsageEvent } from "../adapters/usage.ts";

const DAY_MS = 86_400_000;
const MIN = 60_000;
const BASE = 1_700_000_000_000; // fixed epoch so days bucket deterministically

function ev(ts: number, outputTokens: number): UsageEvent {
  return { ts, model: "m", cwd: "/p/a", outputTokens, totalTokens: outputTokens, costUsd: 0 };
}

/** A day of work: `count` events spaced `spacingMin` apart, `tokens` each. */
function day(dayIndex: number, count: number, spacingMin: number, tokensEach: number): UsageEvent[] {
  const start = BASE + dayIndex * DAY_MS;
  return Array.from({ length: count }, (_, i) => ev(start + i * spacingMin * MIN, tokensEach));
}

describe("activeMs", () => {
  test("no events = zero", () => {
    expect(activeMs([])).toBe(0);
  });

  test("a single event still counts as a minute (never zero)", () => {
    expect(activeMs([BASE])).toBe(MIN);
  });

  test("sums the gaps between consecutive events", () => {
    expect(activeMs([BASE, BASE + 2 * MIN, BASE + 5 * MIN])).toBe(5 * MIN);
  });

  test("caps an idle gap at 5 minutes — a lunch break isn't work", () => {
    // 2min of work, then a 3-hour gap, then 1min: 2 + 5 (capped) + 1
    const ts = [BASE, BASE + 2 * MIN, BASE + 182 * MIN, BASE + 183 * MIN];
    expect(activeMs(ts)).toBe((2 + 5 + 1) * MIN);
  });

  test("unsorted input is handled", () => {
    expect(activeMs([BASE + 5 * MIN, BASE, BASE + 2 * MIN])).toBe(5 * MIN);
  });
});

describe("measureTokensPerMin", () => {
  test("falls back to the default when there's no history", () => {
    const r = measureTokensPerMin([]);
    expect(r.measured).toBe(false);
    expect(r.rate).toBe(DEFAULT_TOKENS_PER_MIN);
  });

  test("falls back when there are too few qualifying days", () => {
    // 2 substantial days — below the 3-day minimum
    const r = measureTokensPerMin([...day(0, 30, 1, 2000), ...day(1, 30, 1, 2000)]);
    expect(r.measured).toBe(false);
    expect(r.samples).toBe(2);
  });

  test("measures the rate from qualifying days", () => {
    // Each day: 31 events 1min apart → 30 gaps = 30min active, 62k tokens
    // → 62000/30 ≈ 2067 tok/min
    const events = [0, 1, 2, 3].flatMap((d) => day(d, 31, 1, 2000));
    const r = measureTokensPerMin(events);
    expect(r.measured).toBe(true);
    expect(r.samples).toBe(4);
    expect(r.rate).toBeCloseTo(2067, -2);
  });

  test("ignores thin days that can't say anything about throughput", () => {
    // 3 real days + one tiny day that would skew the median
    const events = [
      ...[0, 1, 2].flatMap((d) => day(d, 31, 1, 2000)),
      ...day(5, 2, 1, 100), // only 200 tokens — below MIN_DAY_TOKENS
    ];
    const r = measureTokensPerMin(events);
    expect(r.samples).toBe(3);
    expect(r.rate).toBeCloseTo(2067, -2);
  });

  test("takes a median so one marathon day can't skew it", () => {
    const events = [
      ...[0, 1, 2].flatMap((d) => day(d, 31, 1, 2000)), // 2000 tok/min
      ...day(3, 31, 1, 20000), // a 10x outlier day
    ];
    const r = measureTokensPerMin(events);
    // median of [2000,2000,2000,20000] = 2000 (not the 6500 a mean would give)
    expect(r.rate).toBeLessThan(4000);
  });

  test("clamps an implausible rate into the sane band", () => {
    // 31 events 1min apart, 1M tokens each → ~1M tok/min, way past RATE_MAX
    const events = [0, 1, 2].flatMap((d) => day(d, 31, 1, 1_000_000));
    const r = measureTokensPerMin(events);
    expect(r.rate).toBeLessThanOrEqual(10_000);
  });
});
