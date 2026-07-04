import { describe, test, expect } from "bun:test";
import { scoreProject, computeFactors, scoreProjects, snoozedNames } from "./score.ts";
import type { ProjectSignals, Config } from "../types.ts";

function cfg(overrides?: Partial<Config>): Config {
  return {
    paths: { projectsDir: "/p", vaultDir: "/v", claudeDir: "/c" },
    analyze: { provider: "ollama", model: "m", fastModel: "fm", baseUrl: "http://localhost:11434", apiKey: null, maxRounds: 2, numCtx: 8192, temperature: 0.2 },
    shadow: { checkInterval: 300, notifyUrgent: true, hotProjectThreshold: 15000 },
    northStarDeadline: "2026-12-31",
    activeWindowDays: 30,
    subscriptions: [{ name: "max", weeklyTokenCap: null, rolling5hTokenCap: null, resetDay: "Monday" }],
    weights: { roi: 0.2, urgency: 0.1, proximity: 0.15, momentum: 0.15, effort: 0.1, alignment: 0.08, engagement: 0.22 },
    overrides: {},
    ...overrides,
  };
}

function signals(partial?: Partial<ProjectSignals>): ProjectSignals {
  return {
    name: "test",
    path: "/p/test",
    isGit: true,
    lastCommitAt: null,
    daysSinceCommit: null,
    dirtyCount: 0,
    aheadCount: 0,
    branch: null,
    outputTokens: 0,
    recentOutputTokens: 0,
    costUsd: 0,
    override: {},
    ...partial,
  };
}

describe("scoreProject", () => {
  test("score is normalized 0..1", () => {
    const s = scoreProject(signals({ override: { roi: 0, urgency: 0, alignment: 0 } }), cfg());
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(1);
  });

  test("perfect signals produce near-perfect score", () => {
    const s = scoreProject(signals({
      override: { roi: 10, urgency: 10, alignment: 10 },
      recentOutputTokens: 10_000_000,
      analysis: { roi: 10, percentDone: 100, blocker: "", nextAction: "", confidence: 1 },
      dirtyCount: 0,
      aheadCount: 0,
      daysSinceCommit: 0,
      lastCommitAt: new Date(),
    }), cfg());
    expect(s.score).toBeGreaterThan(0.9);
  });

  test("override roi directly raises score vs no roi", () => {
    const high = scoreProject(signals({ override: { roi: 10 } }), cfg());
    const low = scoreProject(signals({ override: { roi: 0 } }), cfg());
    expect(high.score).toBeGreaterThan(low.score);
  });

  test("engagement from recent tokens raises score", () => {
    const engaged = scoreProject(signals({ recentOutputTokens: 1_000_000 }), cfg());
    const none = scoreProject(signals({ recentOutputTokens: 0 }), cfg());
    expect(engaged.score).toBeGreaterThan(none.score);
  });

  test("zero recent tokens = no engagement factor", () => {
    const s = scoreProject(signals({ recentOutputTokens: 0 }), cfg());
    expect(s.factors.engagement).toBe(0);
  });

  test("high engagement maxes at 1.0", () => {
    const s = scoreProject(signals({ recentOutputTokens: 1_000_000_000 }), cfg());
    expect(s.factors.engagement).toBe(1);
  });
});

describe("computeFactors", () => {
  test("proximity from analysis percent_done", () => {
    const s = computeFactors(signals({ analysis: { roi: 5, percentDone: 80, blocker: "x", nextAction: "y", confidence: 0.9 } }), cfg());
    expect(s.proximity).toBeCloseTo(0.8, 5);
  });

  test("no analysis = proximity from git ahead", () => {
    const s = computeFactors(signals({ aheadCount: 5 }), cfg());
    expect(s.proximity).toBeCloseTo(0.55, 5);
  });

  test("no analysis = proximity from dirty files", () => {
    const s = computeFactors(signals({ dirtyCount: 10 }), cfg());
    expect(s.proximity).toBeCloseTo(0.35, 5);
  });

  test("ahead + dirty both contribute to proximity", () => {
    const s = computeFactors(signals({ aheadCount: 2, dirtyCount: 10 }), cfg());
    expect(s.proximity).toBeCloseTo(0.9, 5); // 0.55 + 0.35
  });

  test("no git signal gives zero proximity", () => {
    const s = computeFactors(signals({ isGit: false }), cfg());
    expect(s.proximity).toBe(0);
  });

  test("momentum decays with inactivity", () => {
    const fresh = computeFactors(signals({ daysSinceCommit: 0 }), cfg());
    expect(fresh.momentum).toBe(1);
    const half = computeFactors(signals({ daysSinceCommit: 15 }), cfg());
    expect(half.momentum).toBeCloseTo(0.5, 5);
    const gone = computeFactors(signals({ daysSinceCommit: 30 }), cfg());
    expect(gone.momentum).toBe(0);
  });

  test("null daysSinceCommit gives zero momentum", () => {
    const s = computeFactors(signals({ daysSinceCommit: null }), cfg());
    expect(s.momentum).toBe(0);
  });

  test("effort inverse of dirty files", () => {
    expect(computeFactors(signals({ dirtyCount: 0 }), cfg()).effort).toBe(1);
    expect(computeFactors(signals({ dirtyCount: 100 }), cfg()).effort).toBeCloseTo(0.5, 5);
    expect(computeFactors(signals({ dirtyCount: 200 }), cfg()).effort).toBe(0);
    expect(computeFactors(signals({ dirtyCount: 999 }), cfg()).effort).toBe(0);
  });

  test("roi hierarchy: override > analysis > vault > default", () => {
    const withOverride = computeFactors(
      signals({ override: { roi: 3 }, analysis: { roi: 8, percentDone: 50, blocker: "x", nextAction: "y", confidence: 0.8 }, vault: { title: "t", status: "active", tags: ["ai"], roi: 0.9, alignment: 0.5 } }),
      cfg(),
    );
    expect(withOverride.roi).toBeCloseTo(0.3, 5);
  });

  test("roi without override falls back to analysis", () => {
    const withAnalysis = computeFactors(
      signals({ analysis: { roi: 7, percentDone: 50, blocker: "x", nextAction: "y", confidence: 0.8 } }),
      cfg(),
    );
    expect(withAnalysis.roi).toBeCloseTo(0.7, 5);
  });

  test("roi without override/analysis falls back to vault", () => {
    const withVault = computeFactors(
      signals({ vault: { title: "t", status: "active", tags: ["saas"], roi: 0.9, alignment: 0.5 } }),
      cfg(),
    );
    expect(withVault.roi).toBeCloseTo(0.9, 5);
  });

  test("alignment hierarchy: override > vault > default", () => {
    const withOverride = computeFactors(signals({ override: { alignment: 7 } }), cfg());
    expect(withOverride.alignment).toBeCloseTo(0.7, 5);
  });

  test("urgency from explicit deadline", () => {
    const dueYesterday = computeFactors(signals({ override: { deadline: "2020-01-01" } }), cfg());
    expect(dueYesterday.urgency).toBe(1);
    const farAway = computeFactors(signals({ override: { deadline: "2030-01-01" } }), cfg());
    expect(farAway.urgency).toBe(0);
  });

  test("urgency override takes precedence over deadline", () => {
    const s = computeFactors(signals({ override: { urgency: 10, deadline: "2030-01-01" } }), cfg());
    expect(s.urgency).toBe(1);
  });
});

describe("scoreProjects", () => {
  test("sorts descending by score", () => {
    const low = signals({ name: "low", override: { roi: 1 } });
    const high = signals({ name: "high", override: { roi: 10 }, analysis: { roi: 10, percentDone: 90, blocker: "x", nextAction: "y", confidence: 0.9 } });
    const sorted = scoreProjects([low, high], cfg());
    expect(sorted[0]!.name).toBe("high");
    expect(sorted[1]!.name).toBe("low");
  });

  test("empty input returns empty", () => {
    expect(scoreProjects([], cfg())).toEqual([]);
  });

  test("stable sort for equal scores (preserves input order)", () => {
    const a = signals({ name: "a" });
    const b = signals({ name: "b" });
    const sorted = scoreProjects([a, b], cfg());
    expect(sorted[0]!.name).toBe("a");
    expect(sorted[1]!.name).toBe("b");
  });
});

describe("snoozedNames", () => {
  test("returns set of snoozed project names", () => {
    const s = [signals({ name: "a" }), signals({ name: "b", override: { ignore: true } }), signals({ name: "c", override: { ignore: true } })];
    const snoozed = snoozedNames(s);
    expect(snoozed.has("b")).toBe(true);
    expect(snoozed.has("c")).toBe(true);
    expect(snoozed.has("a")).toBe(false);
    expect(snoozed.size).toBe(2);
  });
});
