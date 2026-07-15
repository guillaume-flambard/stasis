// The routed multi-project itinerary — the anti-scatter answer to "what do I
// do across projects today, in what order, and when do I hop or come back?"
// Deterministic (no LLM). Anchors on your committed focus (or the top score),
// batches it to a checkpoint, then routes ROI-per-token hops onto secondary
// projects while quota headroom lasts. Blocks below the budget line are deferred.
import type { FactorKey, ScoredProject } from "../types.ts";
import type { QuotaStatus, GateLevel } from "./quota.ts";
import { overallGate } from "./quota.ts";
import type { UsageEvent } from "../adapters/usage.ts";

const DAY_MS = 86_400_000;
// Rough conversion of output tokens → wall-clock minutes of active work.
// Calibrated loosely from real sessions (~1.5k output tok/min). An ESTIMATE,
// surfaced as "~Nm", never a promise.
const TOKENS_PER_MIN = 1500;
// A work-block is one mergeable chunk. Clamp estimates so a single giant
// historical day can't make one block eat the whole budget, nor a tiny one vanish.
const BLOCK_MIN = 15_000;
const BLOCK_MAX = 150_000;
const BLOCK_DEFAULT = 40_000; // no history → assume a medium slice
const MAX_BLOCKS = 4;
const MAX_HOPS = 2;
// A hop must earn its context switch — don't route onto a dead/near-zero-ROI
// project just because it's cheap and fits the budget.
const MIN_HOP_ROI = 2;

export type RouteMode = "push" | "sustain" | "conserve";
export type BlockKind = "anchor" | "hop" | "return";

export interface RouteBlock {
  project: string;
  kind: BlockKind;
  task: string; // the concrete next move
  stop: string; // the checkpoint that ends the block
  why: string; // one-line justification for doing it here
  roi: number; // 0..10
  estTokens: number; // output-token estimate for this block
  estMinutes: number; // ~wall-clock estimate
}

export interface DeferredItem {
  project: string;
  roi: number;
  estTokens: number;
  reason: string;
}

export interface RoutePlan {
  gate: GateLevel;
  mode: RouteMode;
  anchor: string | null;
  /** Output-token ceiling for the whole route, or null if uncalibrated + no --hours. */
  budgetTokens: number | null;
  usedTokens: number;
  totalMinutes: number;
  blocks: RouteBlock[];
  deferred: DeferredItem[];
  note: string;
}

const MODE_BY_GATE: Record<GateLevel, RouteMode> = {
  green: "push",
  yellow: "sustain",
  red: "conserve",
};
const PCT_BY_MODE: Record<RouteMode, number> = { push: 0.6, sustain: 0.4, conserve: 0.15 };

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Estimate one work-block's output-token cost for a project from its own
 * history: the median of its daily output-token sums (days with activity).
 * Falls back to a difficulty-scaled default when there's no usage yet.
 */
function estBlockTokens(p: ScoredProject, events: UsageEvent[]): number {
  // No history: scale the default by difficulty (low effort factor = harder).
  const effort = p.factors.effort; // 1 = cheap, 0 = expensive
  const fallback = BLOCK_DEFAULT * (1 + (1 - effort)); // 40k..80k
  return estTokensByName(p.name, events, fallback);
}

/**
 * Same estimate as estBlockTokens but keyed by project name — for an anchor we
 * don't have a ScoredProject for (a committed focus that's off the active board).
 */
function estTokensByName(name: string, events: UsageEvent[], fallback: number): number {
  const perDay = new Map<number, number>();
  for (const e of events) {
    if (!e.cwd.split("/").includes(name)) continue;
    const day = Math.floor(e.ts / DAY_MS);
    perDay.set(day, (perDay.get(day) ?? 0) + e.outputTokens);
  }
  const days = [...perDay.values()].filter((v) => v > 0);
  const est = days.length > 0 ? median(days) : fallback;
  return Math.round(Math.max(BLOCK_MIN, Math.min(BLOCK_MAX, est)));
}

const estMinutes = (tokens: number) => Math.max(5, Math.round(tokens / TOKENS_PER_MIN / 5) * 5);

const roiOf = (p: ScoredProject) => Number((p.factors.roi * 10).toFixed(1));

/** The concrete next move: prefer the AI's nextAction, then its blocker, then a factor reason. */
function taskFor(p: ScoredProject): string {
  const a = p.signals.analysis as { nextAction?: string; blocker?: string } | undefined;
  if (a?.nextAction && a.nextAction !== "unknown") return a.nextAction;
  if (a?.blocker && a.blocker !== "unknown") return `clear blocker: ${a.blocker}`;
  return "carve one mergeable slice";
}

/** Where the block should stop — a mergeable checkpoint, tightened when near-done. */
function stopFor(p: ScoredProject): string {
  return p.factors.proximity >= 0.6 ? "ship it / one real use" : "one mergeable checkpoint";
}

export function buildRoute(
  scored: ScoredProject[],
  quota: QuotaStatus[],
  events: UsageEvent[],
  opts: {
    /** The committed focus (name + bet). Anchors the route. */
    focus?: { project: string; bet?: string } | null;
    /** Is the committed focus a git/code project we can score & token-trace? */
    focusIsCode?: boolean;
    hours?: number;
  } = {},
): RoutePlan {
  const gate = overallGate(quota);
  const mode = MODE_BY_GATE[gate];

  // Token budget: from quota headroom (scaled by mode) and/or an explicit --hours,
  // whichever is tighter. Null when neither is known (uncalibrated, no hours).
  const headroom = todayHeadroom(quota);
  const quotaBudget = headroom == null ? null : Math.round(headroom * PCT_BY_MODE[mode]);
  const hourBudget = opts.hours != null ? Math.round(opts.hours * 60 * TOKENS_PER_MIN) : null;
  let budgetTokens: number | null;
  if (quotaBudget != null && hourBudget != null) budgetTokens = Math.min(quotaBudget, hourBudget);
  else budgetTokens = quotaBudget ?? hourBudget;

  // Snoozed projects (override.ignore) are still scored but excluded from routing.
  const snoozed = new Set(scored.filter((p) => p.signals.override.ignore).map((p) => p.name));

  if (scored.length === 0) {
    return {
      gate, mode, anchor: null, budgetTokens, usedTokens: 0, totalMinutes: 0,
      blocks: [], deferred: [], note: "No active projects. Run `stasis --all` or add one.",
    };
  }

  // Anchor resolution. The committed focus anchors the route — three cases:
  //  - it's an active scored project     → normal anchor block from its score.
  //  - committed but NOT in `scored`      → off-portfolio anchor (a non-git bet
  //    like a job/course, or an inactive repo). Show the commitment itself as
  //    block 1 so the route and the FOCUS banner never disagree, then route hops
  //    onto the portfolio around it.
  //  - no commitment                     → anchor the top non-snoozed score.
  const focusName = opts.focus?.project ?? null;
  const scoredAnchor = focusName ? scored.find((p) => p.name === focusName) ?? null : null;
  const offPortfolio = focusName != null && scoredAnchor == null;
  // The default anchor when no committed focus is present.
  const defaultAnchor = scored.find((p) => !snoozed.has(p.name)) ?? scored[0]!;
  const anchorName = offPortfolio ? focusName! : (scoredAnchor ?? defaultAnchor).name;

  const blocks: RouteBlock[] = [];
  let used = 0;
  const fits = (t: number) => budgetTokens == null || used + t <= budgetTokens;

  // Block 1 — anchor. Always included (it's the commitment); conserve mode
  // shrinks it to a slice regardless.
  let anchorTokens: number;
  if (offPortfolio) {
    // Non-git bets (a job, a course) leave no token trace → estimate 0. An
    // inactive repo still has usage history we can estimate from.
    const isCode = opts.focusIsCode === true;
    anchorTokens = clampConserve(
      isCode ? estTokensByName(focusName!, events, BLOCK_DEFAULT) : 0,
      mode,
    );
    blocks.push({
      project: focusName!,
      kind: "anchor",
      task: opts.focus?.bet?.trim() || "advance your commitment — one concrete step",
      stop: "one concrete step toward the bet",
      why: isCode
        ? "your commitment · off the active board today"
        : "your commitment · off-portfolio · not token-traced",
      roi: 0,
      estTokens: anchorTokens,
      estMinutes: anchorTokens > 0 ? estMinutes(anchorTokens) : 0,
    });
  } else {
    const anchor = scoredAnchor ?? defaultAnchor;
    anchorTokens = clampConserve(estBlockTokens(anchor, events), mode);
    blocks.push({
      project: anchor.name,
      kind: "anchor",
      task: taskFor(anchor),
      stop: stopFor(anchor),
      why: `your anchor · ROI ${roiOf(anchor)}${
        anchor.signals.analysis ? ` · ${anchor.signals.analysis.percentDone}% done` : ""
      }`,
      roi: roiOf(anchor),
      estTokens: anchorTokens,
      estMinutes: estMinutes(anchorTokens),
    });
  }
  used += anchorTokens;

  // Hops — other active projects (excluding snoozed), ranked by ROI-per-token.
  // Conserve mode routes nothing extra; the point is to hold.
  const others = scored
    .filter((p) => p.name !== anchorName && !snoozed.has(p.name))
    .map((p) => {
      const est = estBlockTokens(p, events);
      return { p, est, roiPerK: roiOf(p) / (est / 1000) };
    })
    .sort((a, b) => b.roiPerK - a.roiPerK || b.p.score - a.p.score);

  const used_names = new Set<string>();
  if (mode !== "conserve") {
    let hops = 0;
    for (const { p, est } of others) {
      if (hops >= MAX_HOPS || blocks.length >= MAX_BLOCKS) break;
      if (roiOf(p) < MIN_HOP_ROI) continue; // dead weight — not worth a switch
      if (!fits(est)) continue; // too big for remaining budget → leave for deferred
      blocks.push({
        project: p.name,
        kind: "hop",
        task: taskFor(p),
        stop: stopFor(p),
        why: `ROI ${roiOf(p)} · best return-per-token here · same session`,
        roi: roiOf(p),
        estTokens: est,
        estMinutes: estMinutes(est),
      });
      used += est;
      used_names.add(p.name);
      hops++;
    }

    // Return hop — the "…then back to P1 to finish" leg. Only when the anchor is
    // a scored project that's mid-progress (worth returning to, but not finishable
    // in block 1). Off-portfolio anchors have no proximity, so no return leg.
    const routeAnchor = offPortfolio ? null : (scoredAnchor ?? defaultAnchor);
    const prox = routeAnchor?.factors.proximity ?? 0;
    if (routeAnchor && prox >= 0.4 && prox < 0.7 && blocks.length > 1 && blocks.length < MAX_BLOCKS) {
      const closeTokens = Math.round(anchorTokens * 0.6);
      if (fits(closeTokens)) {
        blocks.push({
          project: routeAnchor.name,
          kind: "return",
          task: `close out: ${taskFor(routeAnchor)}`,
          stop: "ship it",
          why: `highest-value finish — don't leave ${routeAnchor.name} half-done`,
          roi: roiOf(routeAnchor),
          estTokens: closeTokens,
          estMinutes: estMinutes(closeTokens),
        });
        used += closeTokens;
      }
    }
  }

  // Deferred — active candidates that didn't make the route, with an honest reason.
  const routed = new Set(blocks.map((b) => b.project));
  const deferred: DeferredItem[] = others
    .filter(({ p }) => !routed.has(p.name))
    .slice(0, 4)
    .map(({ p, est }) => ({
      project: p.name,
      roi: roiOf(p),
      estTokens: est,
      reason:
        mode === "conserve"
          ? "conserve mode — hold until quota frees"
          : roiOf(p) < MIN_HOP_ROI
            ? "ROI too low to justify a switch"
            : budgetTokens != null && used + est > budgetTokens
              ? `heavy (~${fmtK(est)}) — next window`
              : "lower ROI-per-token",
    }));

  const totalMinutes = blocks.reduce((n, b) => n + b.estMinutes, 0);
  const note =
    offPortfolio && blocks.length === 1
      ? `${anchorName} is your bet but leaves no code trace here — do the real-world work, nothing else pulls.`
      : offPortfolio
        ? `${anchorName} is the bet; the hops below are portfolio work you can batch around it.`
        : mode === "conserve"
          ? `Quota near cap — one small slice on ${anchorName}, defer the rest until reset.`
          : blocks.length === 1
            ? `Single clean run on ${anchorName}. No cheap ROI hop worth the context switch.`
            : `Batch each block to its stop before hopping. The order minimizes cold-starts.`;

  return { gate, mode, anchor: anchorName, budgetTokens, usedTokens: used, totalMinutes, blocks, deferred, note };
}

/** In conserve mode, shrink a block to a token slice so "push hard" can't sneak in. */
function clampConserve(tokens: number, mode: RouteMode): number {
  return mode === "conserve" ? Math.min(tokens, 20_000) : tokens;
}

/** Remaining weekly output-token headroom for TODAY, spread over days until reset. */
function todayHeadroom(quota: QuotaStatus[]): number | null {
  let tightest: number | null = null;
  for (const q of quota) {
    if (q.weekly.cap == null) continue;
    const remainingWeek = Math.max(0, q.weekly.cap - q.weekly.tokens);
    const perDay = remainingWeek / Math.max(1, q.resetInDays);
    tightest = tightest == null ? perDay : Math.min(tightest, perDay);
  }
  return tightest;
}

function fmtK(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}

// re-export so callers can reference the factor label type without a second import
export type { FactorKey };
