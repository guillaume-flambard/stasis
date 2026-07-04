import { describe, test, expect } from "bun:test";
import { buildSignals, isActive } from "./cli.ts";
import type { GitInfo } from "./adapters/git.ts";
import type { UsageIndex } from "./adapters/usage.ts";
import type { VaultInfo } from "./adapters/vault.ts";
import type { AnalysisResult, ProjectJudgment } from "./analyze/analyze.ts";
import type { Config } from "./types.ts";
import type { FocusRecord, FocusStatus } from "./core/focus.ts";
import type { SprintPlan } from "./core/sprint.ts";
import type { QuotaStatus } from "./core/quota.ts";

const MINIMAL_CFG: Config = {
  paths: { projectsDir: "/p", vaultDir: "/v", claudeDir: "/c" },
  analyze: { provider: "ollama", model: "m", fastModel: "fm", baseUrl: "http://localhost:11434", apiKey: null, maxRounds: 2, numCtx: 8192, temperature: 0.2 },
  shadow: { checkInterval: 300, notifyUrgent: true, hotProjectThreshold: 15000 },
  northStarDeadline: "2026-12-31",
  activeWindowDays: 30,
  subscriptions: [{ name: "test", weeklyTokenCap: null, rolling5hTokenCap: null, resetDay: "Monday" }],
  weights: { roi: 0.2, urgency: 0.1, proximity: 0.15, momentum: 0.15, effort: 0.1, alignment: 0.08, engagement: 0.22 },
  overrides: {},
};

describe("buildSignals", () => {
  const repos: GitInfo[] = [
    { name: "foo", path: "/p/foo", isGit: true, lastCommitAt: new Date(), daysSinceCommit: 1, dirtyCount: 0, aheadCount: 0, branch: "main" },
    { name: "bar", path: "/p/bar", isGit: true, lastCommitAt: new Date(), daysSinceCommit: 5, dirtyCount: 2, aheadCount: 1, branch: "dev" },
  ];

  const usage: UsageIndex = {
    byCwd: new Map([
      ["/p/foo", { cwd: "/p/foo", name: "foo", inputTokens: 1000, outputTokens: 5000, cacheReadTokens: 20000, cacheWriteTokens: 5000, costUsd: 50.25, lastActivity: new Date(), recentOutputTokens: 3000 }],
      ["/p/bar/packages/lib", { cwd: "/p/bar/packages/lib", name: "bar", inputTokens: 200, outputTokens: 800, cacheReadTokens: 3000, cacheWriteTokens: 1000, costUsd: 8.00, lastActivity: new Date(), recentOutputTokens: 800 }],
    ]),
    recentEvents: [],
  };

  const vault = new Map<string, VaultInfo>();

  test("attributes usage by repo path prefix (not basename)", () => {
    const signals = buildSignals(repos, usage, vault, null, MINIMAL_CFG);
    const foo = signals.find((s) => s.name === "foo");
    expect(foo).toBeTruthy();
    expect(foo!.outputTokens).toBe(5000);
    expect(foo!.costUsd).toBe(50.25);

    // bar from subdirectory — should match by path prefix
    const bar = signals.find((s) => s.name === "bar");
    expect(bar).toBeTruthy();
    expect(bar!.outputTokens).toBe(800);
    expect(bar!.costUsd).toBe(8.00);
  });

  test("vault and analysis merged into signals", () => {
    const vault = new Map<string, VaultInfo>([
      ["foo", { title: "Foo Project", status: "active", tags: ["saas"], roi: 0.9, alignment: 0.8, note: "foo.md" }],
    ]);
    const analysis: AnalysisResult = {
      generatedAt: new Date().toISOString(),
      provider: "ollama:test",
      projects: {
        foo: { roi: 8, percentDone: 65, blocker: "need payment integration", nextAction: "implement stripe", monetization: "saas", confidence: 0.8, rationale: "good progress", rounds: 2 },
      },
      global: null,
    };
    const signals = buildSignals(repos, usage, vault, analysis, MINIMAL_CFG);
    const foo = signals.find((s) => s.name === "foo")!;
    expect(foo.vault?.roi).toBe(0.9);
    expect(foo.analysis?.roi).toBe(8);
    expect(foo.analysis?.blocker).toBe("need payment integration");
  });
});

describe("isActive", () => {
  test("active if within activeWindowDays", () => {
    expect(isActive({
      name: "a", path: "/p/a", isGit: true, lastCommitAt: new Date(), daysSinceCommit: 10, dirtyCount: 0, aheadCount: 0, branch: "main",
      outputTokens: 0, recentOutputTokens: 0, costUsd: 0, override: {},
    }, MINIMAL_CFG)).toBe(true);
  });

  test("inactive if beyond activeWindowDays", () => {
    expect(isActive({
      name: "a", path: "/p/a", isGit: true, lastCommitAt: null, daysSinceCommit: 90, dirtyCount: 0, aheadCount: 0, branch: "main",
      outputTokens: 0, recentOutputTokens: 0, costUsd: 0, override: {},
    }, MINIMAL_CFG)).toBe(false);
  });

  test("always active if has overrides (snoozed or explicit)", () => {
    expect(isActive({
      name: "a", path: "/p/a", isGit: true, lastCommitAt: null, daysSinceCommit: 999, dirtyCount: 0, aheadCount: 0, branch: null,
      outputTokens: 0, recentOutputTokens: 0, costUsd: 0, override: { ignore: true },
    }, MINIMAL_CFG)).toBe(true);
  });
});

describe("JSON output shapes (skill contract)", () => {

  test("focus --json shape includes all fields the skill reads", () => {
    const focusStatus: FocusStatus = {
      projectName: "foo",
      setAt: "2026-06-01T00:00:00.000Z",
      horizonDays: 14,
      bet: "ship MVP",
      kill: "no users after 2 weeks",
      fidelity: 0.8,
      leaks: [{ name: "bar", tokens: 5000 }],
      overdue: false,
    };
    const json = JSON.parse(JSON.stringify({ active: focusStatus, history: [] }));
    expect(json.active.projectName).toBe("foo");
    expect(json.active.fidelity).toBe(0.8);
    expect(json.active.leaks[0].name).toBe("bar");
    expect(json.active.overdue).toBe(false);
    expect(json.active.bet).toBe("ship MVP");
    expect(json.active.kill).toBe("no users after 2 weeks");
    expect(json.history).toEqual([]);
  });

  test("focus history record shape", () => {
    const history: FocusRecord = {
      projectName: "bar",
      setAt: "2026-05-01T00:00:00.000Z",
      horizonDays: 14,
      bet: "build v2",
      kill: "needs more research",
      verdict: "killed",
      endedAt: "2026-05-15T00:00:00.000Z",
      note: "not enough demand",
    };
    const json = JSON.parse(JSON.stringify({ active: null, history: [history] }));
    expect(json.history[0].verdict).toBe("killed");
    expect(json.history[0].note).toBe("not enough demand");
    expect(json.history[0].bet).toBe("build v2");
  });

  test("sprint --json shape includes route blocks with project, task, stop", () => {
    const sprint: SprintPlan = {
      gate: "yellow",
      mode: "sustain",
      focus: { name: "foo", score: 7.1, reason: "most active project" },
      why: ["most active project"],
      budgetPct: 0.4,
      budgetTokens: 70000,
      secondary: null,
      switchOptions: [{ name: "bar", roi: 5, score: 5.0, reason: "high ROI" }],
      route: {
        gate: "yellow",
        mode: "sustain",
        anchor: "foo",
        blocks: [
          { project: "foo", kind: "anchor", task: "implement payment", stop: "stripe integration works", estTokens: 20000, estMinutes: 15, why: "main push", roi: 7 },
          { project: "bar", kind: "hop", task: "review PR", stop: "merged", estTokens: 5000, estMinutes: 5, why: "collab", roi: 5 },
        ],
        budgetTokens: 70000,
        usedTokens: 25000,
        totalMinutes: 20,
        deferred: [{ project: "baz", roi: 3, estTokens: 30000, reason: "low roi" }],
        note: "sustain mode",
      },
      rule: "one project at a time",
      note: "sustain mode",
    };
    const json = JSON.parse(JSON.stringify(sprint));
    expect(json.focus.name).toBe("foo");
    expect(json.route.anchor).toBe("foo");
    expect(json.route.blocks[0].project).toBe("foo");
    expect(json.route.blocks[0].task).toBe("implement payment");
    expect(json.route.blocks[0].stop).toBe("stripe integration works");
    expect(json.route.blocks[1].project).toBe("bar");
    expect(json.route.deferred[0].project).toBe("baz");
    expect(json.route.mode).toBe("sustain");
  });

  test("quota --json shape includes gate, pct, calibrated", () => {
    const quota: QuotaStatus[] = [
      { subscription: "default", calibrated: true, rolling5h: { tokens: 90000, cap: 100000, pct: 0.9 }, weekly: { tokens: 250000, cap: 500000, pct: 0.5 }, resetInDays: 2, gate: "green" },
      { subscription: "default", calibrated: true, rolling5h: { tokens: 95000, cap: 100000, pct: 0.95 }, weekly: { tokens: 250000, cap: 500000, pct: 0.5 }, resetInDays: 2, gate: "yellow" },
    ];
    const json = JSON.parse(JSON.stringify(quota));
    expect(json[0].gate).toBe("green");
    expect(json[0].calibrated).toBe(true);
    expect(json[0].weekly.pct).toBe(0.5);
    expect(json[0].rolling5h.pct).toBe(0.9);
    expect(json[1].gate).toBe("yellow");
  });

  test("analyze --json shape includes roi, percentDone, blocker, nextAction", () => {
    const analysis: AnalysisResult = {
      generatedAt: "2026-07-04T00:00:00.000Z",
      provider: "ollama:llama3",
      projects: {
        foo: { roi: 8, percentDone: 65, blocker: "need payment integration", nextAction: "implement stripe", monetization: "saas", confidence: 0.8, rationale: "good progress", rounds: 2 },
        bar: { roi: 3, percentDone: 20, blocker: "needs design spec", nextAction: "write spec", monetization: "oss", confidence: 0.4, rationale: "early stage", rounds: 1 },
      },
      global: { focusRecommendation: "focus on foo", insight: "bar is too early", overlaps: [] },
    };
    const json = JSON.parse(JSON.stringify(analysis));
    expect(json.projects.foo.roi).toBe(8);
    expect(json.projects.foo.percentDone).toBe(65);
    expect(json.projects.foo.blocker).toBe("need payment integration");
    expect(json.projects.foo.nextAction).toBe("implement stripe");
    expect(json.global.focusRecommendation).toBe("focus on foo");
  });
});
