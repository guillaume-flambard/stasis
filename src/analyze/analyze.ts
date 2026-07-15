// The AI analysis layer. A local (or remote) model reads each project's real
// evidence and produces STRUCTURED judgment, then challenges its own answer
// (deep, looping), then a global portfolio pass ranks + finds overlaps.
// This is where unstructured reality (code, notes, commits) becomes data.
import type { AnalyzeConfig } from "../types.ts";
import { makeProvider, type AnalyzeProvider } from "./provider.ts";
import { collectEvidence } from "./collect.ts";

export interface ProjectJudgment {
  roi: number; // 0..10 value/revenue potential toward the goal
  percentDone: number; // 0..100 closeness to shippable/usable
  alignment: number; // 0..10 fit to the user's stated goal
  blocker: string;
  nextAction: string;
  monetization: string;
  confidence: number; // 0..1
  rationale: string;
  rounds: number; // how many passes it took
}

export interface GlobalAnalysis {
  ranking: Array<{ name: string; rank: number; why: string }>;
  overlaps: string[];
  focusRecommendation: string;
  insight: string;
}

export interface AnalysisResult {
  generatedAt: string;
  provider: string;
  projects: Record<string, ProjectJudgment>;
  global: GlobalAnalysis | null;
}

export interface AnalyzeTarget {
  name: string;
  dir: string;
  vaultNote?: string;
}

/** The user's goal is injected into every prompt so the AI judges against THEIR
 *  north-star, not a hardcoded one. */
function goalLine(goal: string): string {
  return `The user's goal: ${goal.trim()}. Reward projects that advance this goal; discount those that don't.`;
}

function judgeSystem(goal: string): string {
  return (
    "You are a sharp, skeptical product/portfolio analyst. " +
    goalLine(goal) +
    " You judge a single project from its real evidence (README, commits, files). " +
    "Output ONLY a JSON object with keys: " +
    "roi (integer 0-10, value or revenue potential toward the goal), " +
    "percent_done (integer 0-100, how close to shippable & usable), " +
    "alignment (integer 0-10, how well it fits the user's stated goal), " +
    "blocker (string, the single biggest thing between it and being done/valuable), " +
    "next_action (string, the concrete next move), " +
    "monetization (string, how it creates value or makes money, or 'none'), " +
    "confidence (number 0-1), rationale (one sentence). " +
    "Be honest and specific. A polished README with no product is NOT near done."
  );
}

function num(v: any, lo: number, hi: number, def: number): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

function str(v: any, def = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : def;
}

function toJudgment(raw: any, rounds: number): ProjectJudgment {
  return {
    roi: num(raw.roi, 0, 10, 5),
    percentDone: num(raw.percent_done ?? raw.percentDone, 0, 100, 0),
    alignment: num(raw.alignment, 0, 10, 5),
    blocker: str(raw.blocker, "unknown"),
    nextAction: str(raw.next_action ?? raw.nextAction, "unknown"),
    monetization: str(raw.monetization, "unclear"),
    confidence: num(raw.confidence, 0, 1, 0.4),
    rationale: str(raw.rationale),
    rounds,
  };
}

/** Deep per-project analysis: initial judgment, then self-challenge rounds. */
export async function analyzeProject(
  provider: AnalyzeProvider,
  target: AnalyzeTarget,
  cfg: AnalyzeConfig,
  goal: string,
): Promise<ProjectJudgment> {
  const evidence = collectEvidence(target.name, target.dir, target.vaultNote);
  const system = judgeSystem(goal);

  let raw = await provider.chatJson(system, evidence.text);
  let judgment = toJudgment(raw, 1);

  const rounds = Math.max(1, cfg.maxRounds);
  for (let r = 2; r <= rounds; r++) {
    // Stop early if the model is already confident.
    if (judgment.confidence >= 0.85) break;
    const challenge =
      `Here is your previous judgment of "${target.name}":\n${JSON.stringify({
        roi: judgment.roi,
        percent_done: judgment.percentDone,
        alignment: judgment.alignment,
        blocker: judgment.blocker,
        monetization: judgment.monetization,
      })}\n\n` +
      "Challenge it. Is percent_done truly justified by the commits and files, or optimistic? " +
      "Is the ROI realistic, and is the alignment to the user's goal honest? Is the blocker the real one? " +
      "Re-output the corrected JSON (same keys). Keep values that hold up, fix those that don't.\n\n" +
      "EVIDENCE:\n" +
      evidence.text;
    try {
      raw = await provider.chatJson(system, challenge);
      judgment = toJudgment(raw, r);
    } catch {
      break; // keep last good judgment on a failed round
    }
  }
  return judgment;
}

function globalSystem(goal: string): string {
  return (
    "You are a portfolio strategist. " +
    goalLine(goal) +
    " Given per-project judgments, decide where the user should concentrate to reach the goal fastest. " +
    "Output ONLY a JSON object with keys: " +
    "ranking (array of {name, rank, why}), " +
    "overlaps (array of strings naming projects that duplicate each other or could merge), " +
    "focus_recommendation (string: the ONE project to push now and why), " +
    "insight (string: the single most useful cross-project observation). " +
    "Challenge the naive 'highest ROI wins' — weigh effort-to-value and fit to the goal."
  );
}

export async function analyzeGlobal(
  provider: AnalyzeProvider,
  judgments: Record<string, ProjectJudgment>,
  goal: string,
): Promise<GlobalAnalysis | null> {
  const compact = Object.entries(judgments).map(([name, j]) => ({
    name,
    roi: j.roi,
    percent_done: j.percentDone,
    monetization: j.monetization,
    blocker: j.blocker,
  }));
  if (compact.length === 0) return null;
  try {
    const raw = await provider.chatJson(
      globalSystem(goal),
      "PROJECT JUDGMENTS:\n" + JSON.stringify(compact, null, 1),
    );
    return {
      ranking: Array.isArray(raw.ranking)
        ? raw.ranking.map((x: any, i: number) => ({
            name: str(x.name),
            rank: num(x.rank, 1, 999, i + 1),
            why: str(x.why),
          }))
        : [],
      overlaps: Array.isArray(raw.overlaps) ? raw.overlaps.map((x: any) => str(x)).filter(Boolean) : [],
      focusRecommendation: str(raw.focus_recommendation ?? raw.focusRecommendation),
      insight: str(raw.insight),
    };
  } catch {
    return null;
  }
}

/** Orchestrate: analyze each target (sequential — local model, bounded RAM), then global. */
export async function runAnalysis(
  cfg: AnalyzeConfig,
  targets: AnalyzeTarget[],
  goal: string,
  opts: { global?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<AnalysisResult> {
  const provider = makeProvider(cfg);
  const projects: Record<string, ProjectJudgment> = {};

  let i = 0;
  for (const t of targets) {
    i++;
    opts.onProgress?.(`analyzing ${t.name} (${i}/${targets.length})…`);
    try {
      projects[t.name] = await analyzeProject(provider, t, cfg, goal);
    } catch (e) {
      opts.onProgress?.(`  skipped ${t.name}: ${(e as Error).message}`);
    }
  }

  let global: GlobalAnalysis | null = null;
  if (opts.global !== false && Object.keys(projects).length > 1) {
    opts.onProgress?.("running global portfolio pass…");
    global = await analyzeGlobal(provider, projects, goal);
  }

  return {
    generatedAt: new Date().toISOString(),
    provider: provider.label,
    projects,
    global,
  };
}
