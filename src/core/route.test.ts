import { describe, test, expect } from "bun:test";
import { buildRoute } from "./route.ts";
import type { QuotaStatus, GateLevel } from "./quota.ts";
import type { ScoredProject } from "../types.ts";

function quota(gate: GateLevel = "green", resetInDays = 5, cap = 100_000, tokens = 30_000): QuotaStatus[] {
  const pcts: Record<GateLevel, number> = { green: 0.3, yellow: 0.7, red: 0.95 };
  return [{
    subscription: "test",
    calibrated: true,
    rolling5h: { tokens: 0, cap: cap, pct: 0 },
    weekly: { tokens, cap, pct: pcts[gate] },
    resetInDays,
    gate,
  }];
}

function scored(name: string, factors?: Partial<ScoredProject["factors"]>, analysis?: { percentDone?: number; nextAction?: string; blocker?: string } | false): ScoredProject {
  const f = {
    roi: 0.5,
    urgency: 0.5,
    proximity: 0.5,
    momentum: 0.5,
    effort: 1,
    alignment: 0.5,
    engagement: 0.5,
    ...factors,
  };
  return {
    name,
    path: `/p/${name}`,
    score: Object.values(f).reduce((a, b) => a + b, 0) / 7,
    factors: f,
    signals: {
      name,
      path: `/p/${name}`,
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
      analysis: analysis === false ? undefined : {
        roi: Math.round(f.roi * 10),
        percentDone: analysis?.percentDone ?? 50,
        blocker: analysis?.blocker ?? "none",
        nextAction: analysis?.nextAction ?? "work",
        confidence: 0.8,
      },
    },
  };
}

describe("buildRoute", () => {
  test("empty scored returns null anchor + empty blocks", () => {
    const r = buildRoute([], quota("green"), []);
    expect(r.anchor).toBeNull();
    expect(r.blocks).toEqual([]);
  });

  test("single project = anchor only, no hops", () => {
    const r = buildRoute([scored("a")], quota("green"), []);
    expect(r.anchor).toBe("a");
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]!.kind).toBe("anchor");
    expect(r.blocks[0]!.project).toBe("a");
  });

  test("selects focus project as anchor when present", () => {
    const r = buildRoute([scored("a"), scored("b")], quota("green"), [], { focus: { project: "b" } });
    expect(r.anchor).toBe("b");
  });

  test("off-portfolio focus anchors the route even when not in scored set", () => {
    // A committed bet that isn't a scored project (a non-git dir, or inactive):
    // it must still anchor the route so the FOCUS banner and the route agree.
    const r = buildRoute([scored("a"), scored("b")], quota("green"), [], {
      focus: { project: "n8n", bet: "land the job" },
      focusIsCode: false,
    });
    expect(r.anchor).toBe("n8n");
    expect(r.blocks[0]!.project).toBe("n8n");
    expect(r.blocks[0]!.kind).toBe("anchor");
    expect(r.blocks[0]!.task).toBe("land the job");
  });

  test("non-code off-portfolio anchor costs 0 tokens (leaves no code trace)", () => {
    const r = buildRoute([scored("a")], quota("green"), [], {
      focus: { project: "n8n", bet: "prep interview" },
      focusIsCode: false,
    });
    expect(r.blocks[0]!.estTokens).toBe(0);
  });

  test("off-portfolio focus routes portfolio hops around the anchor", () => {
    const a = scored("a", { roi: 0.9 }, { percentDone: 40, nextAction: "ship a" });
    const bigQuota = quota("green", 1, 1_000_000, 10_000);
    const r = buildRoute([a], bigQuota, [], {
      focus: { project: "n8n", bet: "job" },
      focusIsCode: false,
    });
    // anchor = n8n, plus a is available as a hop (not excluded as anchor).
    expect(r.anchor).toBe("n8n");
    expect(r.blocks.some((bl) => bl.kind === "hop" && bl.project === "a")).toBe(true);
  });

  test("red gate = conserve mode", () => {
    const r = buildRoute([scored("a")], quota("red"), []);
    expect(r.mode).toBe("conserve");
  });

  test("yellow gate = sustain mode", () => {
    const r = buildRoute([scored("a")], quota("yellow"), []);
    expect(r.mode).toBe("sustain");
  });

  test("conserve mode routes no hops", () => {
    const r = buildRoute([scored("a"), scored("b")], quota("red"), []);
    expect(r.blocks).toHaveLength(1);
  });

  test("hops added when budget allows", () => {
    // Large quota so hops fit
    const a = scored("a", {}, { percentDone: 30 });
    const b = scored("b", { roi: 0.9 }, { percentDone: 80, nextAction: "ship b" });
    // Big weekly budget with lots of headroom
    const bigQuota = quota("green", 1, 1_000_000, 10_000);
    const r = buildRoute([a, b], bigQuota, []);
    expect(r.blocks.length).toBeGreaterThanOrEqual(2);
    const hops = r.blocks.filter((bl) => bl.kind === "hop");
    expect(hops.length).toBe(1);
    expect(hops[0]!.project).toBe("b");
  });

  test("return hop created for mid-progress anchor with hops", () => {
    const anchor = scored("a", { proximity: 0.5 }, { percentDone: 50 });
    const second = scored("b", { roi: 0.9 }, { percentDone: 90, nextAction: "ship" });
    // massive budget so anchor + hop + return all fit
    const hugeQuota = quota("green", 1, 1_000_000, 10_000);
    const r = buildRoute([anchor, second], hugeQuota, []);
    const returns = r.blocks.filter((bl) => bl.kind === "return");
    expect(returns.length).toBe(1);
    expect(returns[0]!.project).toBe("a");
  });

  test("no return hop when anchor is near-done (proximity >= 0.7)", () => {
    const anchor = scored("a", { proximity: 0.8 }, { percentDone: 80 });
    const r = buildRoute([anchor, scored("b")], quota("green"), []);
    expect(r.blocks.filter((bl) => bl.kind === "return")).toHaveLength(0);
  });

  test("no return hop when anchor is early (proximity < 0.4)", () => {
    const anchor = scored("a", { proximity: 0.2 }, { percentDone: 20 });
    const r = buildRoute([anchor, scored("b")], quota("green"), []);
    expect(r.blocks.filter((bl) => bl.kind === "return")).toHaveLength(0);
  });

  test("snoozed projects excluded from hops and deferred", () => {
    const a = scored("a");
    const b = scored("b");
    b.signals.override.ignore = true;
    const bigQuota = quota("green", 1, 1_000_000, 10_000);
    const r = buildRoute([a, b], bigQuota, []);
    const hopNames = r.blocks.map((bl) => bl.project);
    expect(hopNames).not.toContain("b");
    expect(r.deferred.find((d) => d.project === "b")).toBeUndefined();
  });

  test("low-ROI projects not routed as hops", () => {
    const a = scored("a", { roi: 0.1 });
    // roi = 0.05 → roiOf = 0.5 → below MIN_HOP_ROI (2)
    const low = scored("low", { roi: 0.05 }, false);
    const bigQuota = quota("green", 1, 1_000_000, 10_000);
    const r = buildRoute([a, low], bigQuota, []);
    const hopNames = r.blocks.map((bl) => bl.project);
    expect(hopNames).not.toContain("low");
  });

  test("budget from quota headroom respected (no over-budget hops)", () => {
    // Tight quota: ~14k/day budget, anchor uses ~40k, no headroom for hops
    const a = scored("a", {}, { percentDone: 30 });
    const b = scored("b", {}, { percentDone: 40 });
    const tight = quota("green", 1, 100_000, 30_000);
    const r = buildRoute([a, b], tight, []);
    // Anchor always included, hops deferred when over budget
    expect(r.blocks).toHaveLength(1);
    expect(r.deferred.find((d) => d.project === "b")).toBeTruthy();
  });

  test("budget from --hours caps the route when tighter than quota", () => {
    const projects = [scored("a")];
    // 0.1 hours = 6 min → 6*1500 = 9000 tokens → tighter than daily quota
    const r = buildRoute(projects, quota("green"), [], { hours: 0.1 });
    // Anchor always included, but budget is set
    expect(r.budgetTokens).toBeLessThan(40000);
  });

  test("task uses nextAction from analysis", () => {
    const p = scored("a", {}, { nextAction: "fix the bug" });
    const r = buildRoute([p], quota("green"), []);
    expect(r.blocks[0]!.task).toContain("fix the bug");
  });

  test("task falls back to blocker when no nextAction set", () => {
    const p = scored("a", {}, false);
    p.signals.analysis = {
      roi: 5, percentDone: 50, blocker: "database migration", nextAction: "unknown", confidence: 0.8,
    };
    const r = buildRoute([p], quota("green"), []);
    expect(r.blocks[0]!.task).toContain("database migration");
  });

  test("budget note for single block", () => {
    const r = buildRoute([scored("a")], quota("green"), []);
    expect(r.blocks).toHaveLength(1);
  });

  test("mode sets the budget proportion", () => {
    const rGreen = buildRoute([scored("a")], quota("green"), []);
    const rRed = buildRoute([scored("a")], quota("red"), []);
    // push mode uses 60%, conserve uses 15%
    expect(rGreen.budgetTokens).toBeGreaterThan(rRed.budgetTokens!);
  });
});
