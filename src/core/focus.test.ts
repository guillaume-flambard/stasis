import { describe, test, expect } from "bun:test";
import { focusStatus, parseHorizon, type Focus } from "./focus.ts";
import type { UsageEvent } from "../adapters/usage.ts";

const DAY_MS = 86_400_000;

function focus(overrides?: Partial<Focus>): Focus {
  return {
    project: "a",
    bet: "ship it",
    kill: "blocked by design",
    setAt: new Date(Date.now() - 5 * DAY_MS).toISOString(),
    horizonDays: 14,
    ...overrides,
  };
}

function event(offsetDays: number, outputTokens: number, cwd: string): UsageEvent {
  return {
    ts: Date.now() - offsetDays * DAY_MS,
    model: "claude-opus-4-8",
    cwd,
    outputTokens,
    totalTokens: outputTokens,
    costUsd: 1,
  };
}

describe("focusStatus", () => {
  test("100% fidelity when all tokens on focus project", () => {
    const f = focus();
    const events = [event(1, 1000, "/p/a")];
    const st = focusStatus(f, events);
    expect(st.fidelity).toBe(1);
    expect(st.focusTokens).toBe(1000);
    expect(st.otherTokens).toBe(0);
  });

  test("0% fidelity when no tokens on focus project", () => {
    const f = focus();
    const events = [event(1, 1000, "/p/b")];
    const st = focusStatus(f, events);
    expect(st.fidelity).toBe(0);
    expect(st.focusTokens).toBe(0);
    expect(st.otherTokens).toBe(1000);
  });

  test("fidelity proportional to focus vs other", () => {
    const f = focus();
    const events = [
      event(1, 3000, "/p/a"),
      event(1, 1000, "/p/b"),
      event(2, 1000, "/p/c"),
    ];
    const st = focusStatus(f, events);
    expect(st.fidelity).toBeCloseTo(0.6, 5); // 3000/5000
  });

  test("events before setAt are excluded", () => {
    const f = focus({ setAt: new Date(Date.now() - 2 * DAY_MS).toISOString() });
    const events = [
      event(10, 5000, "/p/a"), // before focus
      event(1, 1000, "/p/a"),  // after focus
    ];
    const st = focusStatus(f, events);
    expect(st.focusTokens).toBe(1000);
  });

  test("null fidelity when no activity", () => {
    const f = focus();
    const st = focusStatus(f, []);
    expect(st.fidelity).toBeNull();
    expect(st.focusTokens).toBe(0);
    expect(st.otherTokens).toBe(0);
  });

  test("leaks list sorted by tokens descending", () => {
    const f = focus();
    const events = [
      event(1, 500, "/p/a"),   // focus
      event(1, 5000, "/p/b"),  // biggest leak
      event(1, 2000, "/p/c"),
    ];
    const st = focusStatus(f, events);
    expect(st.leaks[0]!.name).toBe("b");
    expect(st.leaks[1]!.name).toBe("c");
  });

  test("leaks capped at 3", () => {
    const f = focus();
    const events = [
      event(1, 100, "/p/a"),
      event(1, 100, "/p/b"),
      event(1, 100, "/p/c"),
      event(1, 100, "/p/d"),
    ];
    const st = focusStatus(f, events);
    expect(st.leaks.length).toBeLessThanOrEqual(3);
  });

  test("overdue when horizon expired", () => {
    const f = focus({ setAt: new Date(Date.now() - 20 * DAY_MS).toISOString(), horizonDays: 10 });
    const st = focusStatus(f, []);
    expect(st.overdue).toBe(true);
    expect(st.daysLeft).toBeLessThanOrEqual(0);
  });

  test("not overdue within horizon", () => {
    const f = focus({ setAt: new Date(Date.now() - 5 * DAY_MS).toISOString(), horizonDays: 14 });
    const st = focusStatus(f, []);
    expect(st.overdue).toBe(false);
    expect(st.daysLeft).toBeGreaterThan(0);
  });

  test("matches project in subdirectory cwd", () => {
    const f = focus({ project: "a" });
    const events = [event(1, 500, "/p/a/packages/lib")];
    const st = focusStatus(f, events);
    expect(st.focusTokens).toBe(500);
  });

  test("does not match similar project name", () => {
    const f = focus({ project: "a" });
    const events = [event(1, 500, "/p/aa")];
    const st = focusStatus(f, events);
    expect(st.otherTokens).toBe(500);
  });
});

describe("parseHorizon", () => {
  test("2w -> 14 days", () => expect(parseHorizon("2w")).toBe(14));
  test("10d -> 10 days", () => expect(parseHorizon("10d")).toBe(10));
  test("1m -> 30 days", () => expect(parseHorizon("1m")).toBe(30));
  test("3 -> 3 days (bare number)", () => expect(parseHorizon("3")).toBe(3));
  test("undefined -> default 14", () => expect(parseHorizon(undefined)).toBe(14));
  test("empty -> default 14", () => expect(parseHorizon("")).toBe(14));
  test("garbage -> default 14", () => expect(parseHorizon("xyz")).toBe(14));
});
