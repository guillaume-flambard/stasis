// Deterministic weighted scoring. Pure functions, no I/O, no tokens.
// Each factor is normalized to 0..1; score = Σ weightᵢ · factorᵢ (also 0..1).
import type { Config, FactorKey, ProjectSignals, ScoredProject } from "../types.ts";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const DAY_MS = 86_400_000;

/** ROI precedence: explicit override > AI analysis > Vault tag hint > neutral 0.5. */
function roiFactor(s: ProjectSignals): number {
  if (s.override.roi != null) return clamp01(s.override.roi / 10);
  if (s.analysis) return clamp01(s.analysis.roi / 10);
  if (s.vault?.roi != null) return clamp01(s.vault.roi);
  return 0.5;
}

/** Urgency: explicit override wins; else deadline proximity vs north-star anchor. */
function urgencyFactor(s: ProjectSignals, cfg: Config): number {
  if (s.override.urgency != null) return clamp01(s.override.urgency / 10);
  const deadline = s.override.deadline ?? cfg.northStarDeadline;
  const ms = Date.parse(deadline);
  if (Number.isNaN(ms)) return 0.5;
  const daysLeft = (ms - Date.now()) / DAY_MS;
  if (daysLeft <= 0) return 1; // overdue = max urgency
  // 0 days → 1, 180+ days → ~0. Linear ramp over 180 days.
  return clamp01(1 - daysLeft / 180);
}

/**
 * Proximity-to-done. AI analysis gives a real %done judgment; without it we fall
 * back to a git proxy (unpushed commits + mid-work signal a checkpoint).
 */
function proximityFactor(s: ProjectSignals): number {
  if (s.analysis) return clamp01(s.analysis.percentDone / 100);
  const aheadTerm = s.aheadCount > 0 ? 0.55 : 0;
  const dirtyTerm = s.dirtyCount > 0 && s.dirtyCount <= 30 ? 0.35 : 0;
  return clamp01(aheadTerm + dirtyTerm);
}

/** Momentum: recent commits = warm, cheap to resume. */
function momentumFactor(s: ProjectSignals, cfg: Config): number {
  if (s.daysSinceCommit == null) return 0;
  return clamp01(1 - s.daysSinceCommit / cfg.activeWindowDays);
}

/** Effort-inverse: large uncommitted sprawl = expensive to finish → lower. */
function effortFactor(s: ProjectSignals): number {
  // >200 dirty files reads as migration/mess; ramp down from a clean baseline.
  return clamp01(1 - s.dirtyCount / 200);
}

/** Alignment to north-star: override wins, else Vault tag-derived, else neutral. */
function alignmentFactor(s: ProjectSignals): number {
  if (s.override.alignment != null) return clamp01(s.override.alignment / 10);
  if (s.vault?.alignment != null) return clamp01(s.vault.alignment);
  return 0.5;
}

/**
 * Engagement: recent token investment. Vault-INDEPENDENT — a project you're
 * actively pouring tokens into ranks up even with no note and no override.
 * Log scale so 1M recent output tokens ≈ 1.0, 10k ≈ 0.67, 0 → 0.
 */
function engagementFactor(s: ProjectSignals): number {
  if (s.recentOutputTokens <= 0) return 0;
  return clamp01(Math.log10(1 + s.recentOutputTokens) / 6);
}

export function computeFactors(s: ProjectSignals, cfg: Config): Record<FactorKey, number> {
  return {
    roi: roiFactor(s),
    urgency: urgencyFactor(s, cfg),
    proximity: proximityFactor(s),
    momentum: momentumFactor(s, cfg),
    effort: effortFactor(s),
    alignment: alignmentFactor(s),
    engagement: engagementFactor(s),
  };
}

export function scoreProject(s: ProjectSignals, cfg: Config): ScoredProject {
  const factors = computeFactors(s, cfg);
  const w = cfg.weights;
  const score =
    factors.roi * w.roi +
    factors.urgency * w.urgency +
    factors.proximity * w.proximity +
    factors.momentum * w.momentum +
    factors.effort * w.effort +
    factors.alignment * w.alignment +
    factors.engagement * w.engagement;
  return { name: s.name, path: s.path, score, factors, signals: s };
}

export function scoreProjects(signals: ProjectSignals[], cfg: Config): ScoredProject[] {
  return signals
    .map((s) => scoreProject(s, cfg))
    .sort((a, b) => b.score - a.score);
}

/** Projects that are still scored but marked as snoozed (excluded from routing). */
export function snoozedNames(signals: ProjectSignals[]): Set<string> {
  return new Set(signals.filter((s) => s.override.ignore).map((s) => s.name));
}
