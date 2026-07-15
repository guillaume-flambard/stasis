// Turns ranked scores + quota into a single-focus, context-switch-minimizing
// daily plan. Deterministic (no LLM); the /stasis skill narrates it from --json.
import type { FactorKey, ScoredProject } from "../types.ts";
import type { QuotaStatus, GateLevel } from "./quota.ts";
import { overallGate } from "./quota.ts";
import { buildRoute, type RoutePlan } from "./route.ts";
import type { UsageEvent } from "../adapters/usage.ts";

export type SprintMode = "push" | "sustain" | "conserve";

export interface SwitchOption {
  name: string;
  roi: number; // 0..10
  score: number; // 0..10
  reason: string;
}

export interface SprintPlan {
  gate: GateLevel;
  mode: SprintMode;
  focus: { name: string; score: number; reason: string } | null;
  /** Why THIS focus, WHEN to sprint, HOW — 2–4 analysis lines. */
  why: string[];
  /** Suggested share (0..1) of today's remaining quota to spend on focus. */
  budgetPct: number;
  /** Suggested output-token ceiling for today, or null if caps unknown. */
  budgetTokens: number | null;
  secondary: { name: string; reason: string } | null;
  /** ROI-ranked alternatives to deliberately switch to (excludes focus). */
  switchOptions: SwitchOption[];
  /** The routed multi-project itinerary — anchor → hops → return, quota-bounded. */
  route: RoutePlan;
  rule: string;
  note: string;
}

const FACTOR_LABEL: Record<FactorKey, string> = {
  roi: "high ROI",
  urgency: "deadline pressure",
  proximity: "near shippable",
  momentum: "warm/recent",
  effort: "cheap to finish",
  alignment: "north-star fit",
  engagement: "heavy active investment",
};

/** Two dominant factors (weighted contribution) → a short human reason. */
function reasonFor(p: ScoredProject, weights: Record<FactorKey, number>): string {
  const contrib = (Object.keys(p.factors) as FactorKey[])
    .map((k) => ({ k, v: p.factors[k] * (weights[k] ?? 0) }))
    .sort((a, b) => b.v - a.v);
  const top = contrib.slice(0, 2).filter((c) => c.v > 0.05);
  if (top.length === 0) return "steady baseline";
  return top.map((c) => FACTOR_LABEL[c.k]).join(" + ");
}

/** Human WHY / WHEN / HOW lines explaining the focus call. */
function analysis(
  top: ScoredProject,
  mode: SprintMode,
  budgetTokens: number | null,
  resetInDays: number | null,
  weights: Record<FactorKey, number>,
): string[] {
  const out: string[] = [];

  // WHY — the two dominant weighted factors, with their 0..10 values.
  const ranked = (Object.keys(top.factors) as FactorKey[])
    .map((k) => ({ k, contrib: top.factors[k] * (weights[k] ?? 0), val: top.factors[k] }))
    .sort((a, b) => b.contrib - a.contrib);
  const drivers = ranked
    .slice(0, 2)
    .filter((d) => d.contrib > 0.05)
    .map((d) => `${FACTOR_LABEL[d.k]} (${(d.val * 10).toFixed(0)}/10)`);
  out.push(
    `WHY ${top.name}: ${drivers.length ? drivers.join(", ") : "highest overall score"}.`,
  );

  // WHEN — quota timing.
  const reset = resetInDays != null ? `reset in ${resetInDays}d` : "reset unknown";
  if (mode === "push") out.push(`WHEN: fresh quota — deep-work window now (${reset}).`);
  else if (mode === "sustain") out.push(`WHEN: mid-week — pace it, don't spike (${reset}).`);
  else out.push(`WHEN: near cap — hold heavy work until ${reset}.`);

  // HOW — proximity drives the tactic.
  const prox = top.factors.proximity;
  const budget = budgetTokens != null ? ` within ~${fmtK(budgetTokens)} output tok` : "";
  if (mode === "conserve") {
    out.push(`HOW: small, cheap tasks${budget}; save the big push for after reset.`);
  } else if (prox >= 0.5) {
    out.push(`HOW: it's near a checkpoint — drive one feature to merge${budget}, then stop.`);
  } else {
    out.push(`HOW: carve ONE mergeable slice${budget}; avoid opening a second repo.`);
  }
  return out;
}

function fmtK(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}

const MODE_BY_GATE: Record<GateLevel, SprintMode> = {
  green: "push",
  yellow: "sustain",
  red: "conserve",
};
const PCT_BY_MODE: Record<SprintMode, number> = { push: 0.6, sustain: 0.4, conserve: 0.15 };

export interface SprintOpts {
  /** Recent usage events — feed per-project block-cost estimates in the route. */
  events?: UsageEvent[];
  /** The committed focus (name + bet); anchors the route even off the board. */
  focus?: { project: string; bet?: string } | null;
  /** Is the committed focus a git/code project (scoreable & token-traceable)? */
  focusIsCode?: boolean;
  /** Session length in hours — sizes the route budget to your actual time. */
  hours?: number;
}

export function buildSprint(
  scored: ScoredProject[],
  quota: QuotaStatus[],
  weights: Record<FactorKey, number>,
  opts: SprintOpts = {},
): SprintPlan {
  const gate = overallGate(quota);
  const mode = MODE_BY_GATE[gate];
  const budgetPct = PCT_BY_MODE[mode];

  const route = buildRoute(scored, quota, opts.events ?? [], {
    focus: opts.focus,
    focusIsCode: opts.focusIsCode,
    hours: opts.hours,
  });
  const budgetTokens = route.budgetTokens;

  if (scored.length === 0) {
    return {
      gate,
      mode,
      focus: null,
      why: [],
      budgetPct,
      budgetTokens,
      secondary: null,
      switchOptions: [],
      route,
      rule: "No active projects. Run `stasis --all` or add one.",
      note: "",
    };
  }

  const top = scored[0]!;
  const focus = { name: top.name, score: top.score, reason: reasonFor(top, weights) };

  // Secondary = next-best project, offered ONLY as a fallback when blocked.
  const second = scored[1];
  const secondary = second
    ? { name: second.name, reason: reasonFor(second, weights) }
    : null;

  // WHY / WHEN / HOW analysis.
  const resetInDays = quota[0]?.resetInDays ?? null;
  const why = analysis(top, mode, budgetTokens, resetInDays, weights);

  // ROI-ranked switch menu: deliberately change project by ROI, not by whim.
  // Snoozed projects (override.ignore) excluded — they're set aside.
  const switchOptions: SwitchOption[] = scored
    .filter((p) => p.name !== top.name && !p.signals.override.ignore)
    .map((p) => ({
      name: p.name,
      roi: Number((p.factors.roi * 10).toFixed(1)),
      score: Number((p.score * 10).toFixed(1)),
      reason: reasonFor(p, weights),
    }))
    .sort((a, b) => b.roi - a.roi || b.score - a.score)
    .slice(0, 4);

  let rule: string;
  let note: string;
  if (mode === "conserve") {
    rule = `Conserve: quota near cap. Cheap tasks / cheaper model / local no-AI work only.`;
    note = `Defer heavy work on ${top.name} until the window frees up (reset in ${
      quota[0]?.resetInDays ?? "?"
    }d).`;
  } else {
    rule = `Single focus: ${top.name}. Finish + merge a checkpoint before switching projects.`;
    note =
      mode === "sustain"
        ? `Mid-week: pace it. Batch work on ${top.name}; avoid cold-starting a second repo.`
        : `Fresh quota: push hard on ${top.name} while the cache stays warm.`;
  }

  return { gate, mode, focus, why, budgetPct, budgetTokens, secondary, switchOptions, route, rule, note };
}
