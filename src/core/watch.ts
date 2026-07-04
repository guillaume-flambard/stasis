import type { Config } from "../config.ts";
import { parseUsage, type UsageEvent } from "../adapters/usage.ts";
import { loadFocus, focusStatus, type FocusState } from "./focus.ts";
import { computeQuota, overallGate, loadCalib, type GateLevel, type QuotaStatus } from "./quota.ts";
import { buildSprint } from "./sprint.ts";
import { scoreProjects } from "./score.ts";
import type { ScoredProject } from "../types.ts";
import type { RoutePlan } from "./route.ts";
import { scanRepos } from "../adapters/git.ts";
import { loadVault } from "../adapters/vault.ts";
import { buildSignals, isActive } from "../cli.ts";
import {
  loadShadowState,
  saveShadowState,
  writeShadowAdvice,
  appendShadowLog,
  ensureProjectHistory,
  pushEvent,
  pruneEventsSeen,
  buildAdvice,
} from "../adapters/shadow.ts";
import { notify } from "../adapters/notify.ts";
import type {
  ShadowState,
  ShadowAdvice,
  ShadowEvent,
} from "../types.ts";

export interface WatchTickInput {
  cfg: Config;
  state: ShadowState;
  now: number;
}

export interface WatchTickResult {
  events: ShadowEvent[];
  advice: ShadowAdvice | null;
  state: ShadowState;
}

const DAY_MS = 86_400_000;

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function fmtK(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}

/** Per-project output tokens from recent events, keyed by repo basename. */
function projectOutputMap(events: UsageEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) {
    const name = e.cwd.split("/").pop() ?? e.cwd;
    m.set(name, (m.get(name) ?? 0) + e.outputTokens);
  }
  return m;
}

/** Names of projects in the current route (anchor + hops). */
function routeProjectNames(route: RoutePlan): Set<string> {
  return new Set(route.blocks.map((b) => b.project));
}

// ── Detectors ──────────────────────────────────────────────────────────

interface DetectorContext {
  cfg: Config;
  state: ShadowState;
  now: number;
  scored: ScoredProject[];
  route: RoutePlan;
  usage: { allEvents: UsageEvent[]; recentEvents: UsageEvent[] };
  focusState: FocusState;
  quota: QuotaStatus[];
  gate: GateLevel;
  snoozed: Set<string>;
  projectOutput: Map<string, number>;
  day: string;
  events: ShadowEvent[];
}

function detectScatter(ctx: DetectorContext): void {
  const f = ctx.focusState.active;
  if (!f) return;
  const st = focusStatus(f, ctx.usage.recentEvents, ctx.now);
  if (st.fidelity == null) return;

  const prevFid = ctx.state.lastMeta["fidelity"] ?? 1;
  if (prevFid >= 0.6 && st.fidelity < 0.6) {
    const activeHops = routeProjectNames(ctx.route);
    const leaksOffRoute = st.leaks.filter((l) => !activeHops.has(l.name) && !ctx.snoozed.has(l.name));

    if (leaksOffRoute.length > 0) {
      const leakNames = leaksOffRoute.map((l) => `${l.name} (${fmtK(l.tokens)})`).join(", ");
      const msg = `⚠️ Scatter — fidelity dropped to ${Math.round(st.fidelity * 100)}%. Off-route leaks: ${leakNames}. Re-commit or re-evaluate?`;
      ctx.events.push(pushEvent(ctx.state, "scatter", f.project, msg, {
        fidelity: st.fidelity, leaks: st.leaks, leaksOffRoute: leaksOffRoute.map((l) => l.name),
      }));
    }
  }
  ctx.state.lastMeta["fidelity"] = st.fidelity;
}

function detectQuotaCritical(ctx: DetectorContext): void {
  const prevGateNum = ctx.state.lastMeta["gate"] ?? 0;
  const gateNum: Record<string, number> = { green: 0, yellow: 1, red: 2 };
  if (prevGateNum < 2 && ctx.gate === "red") {
    const pct = ctx.quota.map((q) => `5h:${Math.round((q.rolling5h.pct ?? 0) * 100)}%`).join(", ");
    const msg = `🔴 Quota critical — gate is RED (${pct}). Switch to conserve mode.`;
    ctx.events.push(pushEvent(ctx.state, "quota_critical", null, msg, { gate: ctx.gate, quota: ctx.quota }));
  }
  ctx.state.lastMeta["gate"] = gateNum[ctx.gate] ?? 0;
}

function detectFocusOverdue(ctx: DetectorContext): void {
  const f = ctx.focusState.active;
  if (!f) return;
  const st = focusStatus(f, ctx.usage.recentEvents, ctx.now);
  const prevOverdue = ctx.state.lastMeta["overdue"] === 1;
  if (!prevOverdue && st.overdue) {
    const msg = `⏰ Focus overdue — "${f.project}" horizon expired without verdict. Run \`stasis focus review\`.`;
    ctx.events.push(pushEvent(ctx.state, "focus_overdue", f.project, msg, {
      project: f.project, bet: f.bet, kill: f.kill,
    }));
  }
  ctx.state.lastMeta["overdue"] = st.overdue ? 1 : 0;
}

function detectHotProject(ctx: DetectorContext): void {
  const threshold = ctx.cfg.shadow.hotProjectThreshold;
  const routeNames = routeProjectNames(ctx.route);
  const focusName = ctx.focusState.active?.project;

  for (const [name, tokens] of ctx.projectOutput) {
    if (ctx.snoozed.has(name)) continue;
    if (name === focusName) continue;
    if (routeNames.has(name)) continue;

    const prev = ctx.state.lastCheckProjectOutput[name] ?? 0;
    const delta = tokens - prev;
    if (delta >= threshold) {
      const hist = ensureProjectHistory(ctx.state, name);
      const msg = `🔥 Hot project — "${name}" got ${fmtK(delta)} tokens since last check (not in route). Consider routing or snoozing.`;
      ctx.events.push(pushEvent(ctx.state, "hot_project", name, msg, {
        delta, total: tokens, timesDeferred: hist.totalSprintsDeferred,
      }));
    }
  }
}

function detectSprintBlockDone(ctx: DetectorContext): void {
  const focusName = ctx.focusState.active?.project;
  if (!focusName) return;

  for (const block of ctx.route.blocks) {
    const actual = ctx.projectOutput.get(block.project) ?? 0;
    const prev = ctx.state.lastCheckProjectOutput[block.project] ?? 0;
    const blockActual = actual - prev;

    if (blockActual >= block.estTokens * 0.9) {
      const emoji = block.kind === "anchor" ? "✅" : block.kind === "hop" ? "↩" : "🏁";
      const msg = `${emoji} Sprint block done — "${block.project}" (${block.kind}) spent ${fmtK(blockActual)}/${fmtK(block.estTokens)} tok. ${block.kind === "hop" ? "Ready to return to anchor." : block.kind === "anchor" ? "Checkpoint reached. Next block?" : "Route complete."}`;
      ctx.events.push(pushEvent(ctx.state, "sprint_block_done", block.project, msg, {
        kind: block.kind, estTokens: block.estTokens, actualTokens: blockActual, task: block.task, stop: block.stop,
      }));
    }
  }
}

// ── Main tick ──────────────────────────────────────────────────────────

export async function runWatchTick(
  cfg: Config,
  state: ShadowState,
  now = Date.now(),
): Promise<WatchTickResult> {
  pruneEventsSeen(state);
  const day = dayKey(now);
  const events: ShadowEvent[] = [];

  // Load current state
  const [repos, usageIndex, vault] = await Promise.all([
    scanRepos(cfg.paths.projectsDir),
    parseUsage(cfg.paths.claudeDir),
    loadVault(cfg.paths.vaultDir),
  ]);
  const focusState = loadFocus();

  const signals = buildSignals(repos, usageIndex, vault, null, cfg).filter((s) => s.isGit);
  const activeSignals = signals.filter((s) => isActive(s, cfg));
  const scored = scoreProjects(activeSignals, cfg);
  const quota = computeQuota(cfg.subscriptions, usageIndex.recentEvents, loadCalib());
  const gate = overallGate(quota);

  const sprint = buildSprint(scored, quota, cfg.weights, {
    events: usageIndex.recentEvents,
    focusProject: focusState.active?.project ?? null,
  });
  const route = sprint.route;

  const snoozed = new Set(scored.filter((p) => p.signals.override.ignore).map((p) => p.name));
  const projectOutput = projectOutputMap(usageIndex.recentEvents);

  const ctx: DetectorContext = {
    cfg, state, now,
    scored, route,
    usage: { allEvents: usageIndex.recentEvents, recentEvents: usageIndex.recentEvents },
    focusState, quota, gate, snoozed, projectOutput,
    day, events,
  };

  // Run detectors (all gated: skip first tick — no baseline for any of them)
  if (state.lastCheckMs > 0) {
    detectScatter(ctx);
    detectQuotaCritical(ctx);
    detectFocusOverdue(ctx);
    detectHotProject(ctx);
    detectSprintBlockDone(ctx);
  }

  // First tick: record baseline and still fire quota_critical if gate was red
  // before we started watching (useful advice when first starting the daemon).
  if (state.lastCheckMs === 0 && ctx.gate === "red") {
    const pct = ctx.quota.map((q) => `5h:${Math.round((q.rolling5h.pct ?? 0) * 100)}%`).join(", ");
    const msg = `🔴 Quota critical — gate is RED (${pct}). Switch to conserve mode.`;
    ctx.events.push(pushEvent(ctx.state, "quota_critical", null, msg, { gate: ctx.gate, quota: ctx.quota }));
  }

  // Update per-project history
  for (const [name, tokens] of projectOutput) {
    const hist = ensureProjectHistory(state, name);
    if (tokens > 0) hist.lastActiveAt = new Date(now).toISOString();
  }
  const routeNames = routeProjectNames(route);
  for (const block of ctx.route.blocks) {
    const hist = ensureProjectHistory(state, block.project);
    hist.lastInRouteAt = new Date(now).toISOString();
  }

  // Snapshot per-project output tokens for next tick
  state.lastCheckProjectOutput = {};
  for (const [name, tokens] of projectOutput) {
    state.lastCheckProjectOutput[name] = tokens;
  }

  state.lastCheckMs = now;
  saveShadowState(state);

  // Build advice
  const advice = buildAdvice(state);
  if (advice) writeShadowAdvice(advice);

  // Log + notify
  if (events.length > 0) {
    if (!state.dailyLog[day]) state.dailyLog[day] = "";
    for (const ev of events) {
      const line = `- **${ev.kind}** ${ev.project ? `(\`${ev.project}\`)` : ""} ${ev.message}`;
      state.dailyLog[day] += line + "\n";
      appendShadowLog(day, line);

      if (cfg.shadow.notifyUrgent && ["scatter", "quota_critical", "focus_overdue"].includes(ev.kind)) {
        notify("stasis", ev.kind.replace("_", " "), ev.message);
      }
    }
    saveShadowState(state);
  }

  return { events, advice, state };
}

// ── Watch loop ─────────────────────────────────────────────────────────

export interface WatchLoopOpts {
  intervalMs: number;
  onTick: (result: WatchTickResult, tick: number) => void;
  onError: (err: Error) => void;
}

export async function runWatchLoop(
  cfg: Config,
  opts: WatchLoopOpts,
): Promise<void> {
  let state = loadShadowState();
  let tick = 0;

  const tickFn = async () => {
    tick++;
    try {
      const result = await runWatchTick(cfg, state, Date.now());
      state = result.state;
      opts.onTick(result, tick);
    } catch (err) {
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  await tickFn();
  setInterval(tickFn, opts.intervalMs);
}
