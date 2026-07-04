import { describe, test, expect } from "bun:test";
import { outputBetween, calibrate, computeQuota, overallGate } from "./quota.ts";
import type { UsageEvent } from "../adapters/usage.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function ev(offsetHours: number, outputTokens: number, cwd = "test"): UsageEvent {
  return {
    ts: Date.now() - offsetHours * HOUR_MS,
    model: "claude-opus-4-8",
    cwd,
    outputTokens,
    totalTokens: outputTokens,
    costUsd: 1,
  };
}

describe("outputBetween", () => {
  test("empty events returns 0", () => {
    expect(outputBetween([], 0)).toBe(0);
  });

  test("counts tokens in window", () => {
    const events = [ev(1, 100), ev(2, 200), ev(10, 300)];
    expect(outputBetween(events, Date.now() - 5 * HOUR_MS)).toBe(300); // only ev(1) + ev(2)
  });

  test("excludes events before since", () => {
    const events = [ev(1, 100), ev(5, 200)];
    expect(outputBetween(events, Date.now() - 3 * HOUR_MS)).toBe(100); // only ev(1)
  });
});

describe("calibrate", () => {
  test("computes weekCap from reading", () => {
    const events = [ev(0, 50000)];
    const calib = calibrate(events, { week: 50 }, "Monday");
    expect(calib.weekCap).toBe(100_000); // 50000 / 0.5
    expect(calib.fiveHCap).toBeUndefined();
  });

  test("computes fiveHCap from reading", () => {
    const events = [
      ev(0.5, 1000),  // 30 min ago
      ev(2, 2000),    // 2h ago
      ev(6, 3000),    // 6h ago — outside 5h window
    ];
    const calib = calibrate(events, { fiveH: 25 }, "Monday");
    // only 1000+2000 = 3000 in 5h window. 3000 / 0.25 = 12000
    expect(calib.fiveHCap).toBe(12000);
  });

  test("zero reading returns no cap", () => {
    const calib = calibrate([], { week: 0, fiveH: 0 }, "Monday");
    expect(calib.weekCap).toBeUndefined();
    expect(calib.fiveHCap).toBeUndefined();
  });

  test("zero burn returns no cap", () => {
    const calib = calibrate([], { week: 50 }, "Monday");
    expect(calib.weekCap).toBeUndefined();
  });
});

describe("computeQuota", () => {
  const sub = { name: "test", weeklyTokenCap: null, rolling5hTokenCap: null, resetDay: "Monday" };

  test("uncalibrated = green gate with raw burn", () => {
    const q = computeQuota([sub], [ev(0, 1000)], null);
    expect(q[0]!.calibrated).toBe(false);
    expect(q[0]!.gate).toBe("green");
    expect(q[0]!.rolling5h.pct).toBeNull();
    expect(q[0]!.weekly.pct).toBeNull();
  });

  test("calibrated shows pct below cap", () => {
    const calib = { at: new Date().toISOString(), weekCap: 100_000, fiveHCap: 20_000 };
    const events = [ev(0, 5000), ev(2, 3000)]; // ~8k in 5h, ~8k this week
    const q = computeQuota([sub], events, calib);
    expect(q[0]!.calibrated).toBe(true);
    expect(q[0]!.rolling5h.pct).toBeCloseTo(8000 / 20000, 1);
    expect(q[0]!.weekly.pct).toBeCloseTo(8000 / 100000, 1);
  });

  test("near cap = red gate", () => {
    const calib = { at: new Date().toISOString(), weekCap: 100_000 };
    const q = computeQuota([sub], [ev(0, 95000)], calib);
    expect(q[0]!.gate).toBe("red");
  });

  test("mid cap = yellow gate", () => {
    const calib = { at: new Date().toISOString(), weekCap: 100_000 };
    const q = computeQuota([sub], [ev(0, 70000)], calib);
    expect(q[0]!.gate).toBe("yellow");
  });

  test("low cap = green gate", () => {
    const calib = { at: new Date().toISOString(), weekCap: 100_000 };
    const q = computeQuota([sub], [ev(0, 30000)], calib);
    expect(q[0]!.gate).toBe("green");
  });
});

describe("overallGate", () => {
  test("red if any red", () => {
    expect(overallGate([
      { subscription: "a", calibrated: true, rolling5h: { tokens: 0, cap: null, pct: null }, weekly: { tokens: 0, cap: null, pct: null }, resetInDays: 1, gate: "green" as const },
      { subscription: "b", calibrated: true, rolling5h: { tokens: 0, cap: null, pct: null }, weekly: { tokens: 0, cap: null, pct: null }, resetInDays: 1, gate: "red" as const },
    ])).toBe("red");
  });

  test("yellow if any yellow, no red", () => {
    expect(overallGate([
      { subscription: "a", calibrated: true, rolling5h: { tokens: 0, cap: null, pct: null }, weekly: { tokens: 0, cap: null, pct: null }, resetInDays: 1, gate: "green" as const },
      { subscription: "b", calibrated: true, rolling5h: { tokens: 0, cap: null, pct: null }, weekly: { tokens: 0, cap: null, pct: null }, resetInDays: 1, gate: "yellow" as const },
    ])).toBe("yellow");
  });

  test("green if all green", () => {
    expect(overallGate([
      { subscription: "a", calibrated: true, rolling5h: { tokens: 0, cap: null, pct: null }, weekly: { tokens: 0, cap: null, pct: null }, resetInDays: 1, gate: "green" as const },
      { subscription: "b", calibrated: true, rolling5h: { tokens: 0, cap: null, pct: null }, weekly: { tokens: 0, cap: null, pct: null }, resetInDays: 1, gate: "green" as const },
    ])).toBe("green");
  });

  test("empty = green", () => {
    expect(overallGate([])).toBe("green");
  });
});
