import { describe, test, expect } from "bun:test";
import { DEFAULT_CONFIG, mergeConfig } from "./config.ts";
import type { Config } from "./types.ts";

describe("goal profile defaults", () => {
  test("default config has a generic goal with no deadline", () => {
    expect(DEFAULT_CONFIG.goal.statement.length).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.goal.deadline).toBeNull();
  });

  test("default config no longer carries a hardcoded northStarDeadline", () => {
    expect((DEFAULT_CONFIG as Record<string, unknown>).northStarDeadline).toBeUndefined();
  });
});

describe("mergeConfig goal migration", () => {
  test("legacy northStarDeadline migrates into goal.deadline", () => {
    const user = { northStarDeadline: "2027-03-01" } as Partial<Config>;
    const merged = mergeConfig(DEFAULT_CONFIG, user);
    expect(merged.goal.deadline).toBe("2027-03-01");
    expect(merged.goal.statement).toBe(DEFAULT_CONFIG.goal.statement);
  });

  test("explicit goal wins over legacy field", () => {
    const user = {
      goal: { statement: "my goal", deadline: "2026-09-09" },
      northStarDeadline: "2027-03-01",
    } as Partial<Config>;
    const merged = mergeConfig(DEFAULT_CONFIG, user);
    expect(merged.goal.statement).toBe("my goal");
    expect(merged.goal.deadline).toBe("2026-09-09");
  });

  test("no goal and no legacy field → default goal", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {});
    expect(merged.goal).toEqual(DEFAULT_CONFIG.goal);
  });
});
