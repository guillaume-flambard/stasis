// Shared domain types for stasis.

export type FactorKey =
  | "roi"
  | "urgency"
  | "proximity"
  | "momentum"
  | "effort"
  | "alignment"
  | "engagement";

export interface Weights {
  roi: number;
  urgency: number;
  proximity: number;
  momentum: number;
  effort: number;
  alignment: number;
  /** Recent token investment — Vault-independent signal of active priority. */
  engagement: number;
}

export interface Subscription {
  name: string;
  /** Rough weekly output-token cap for this tier, or null if unknown. */
  weeklyTokenCap: number | null;
  /** Rough 5h-window output-token cap, or null if unknown. */
  rolling5hTokenCap: number | null;
  /** Day the weekly cap resets, e.g. "Monday". */
  resetDay: string;
}

/** Per-project manual overrides for factors we can't derive (0..10 scale). */
export interface ProjectOverride {
  roi?: number;
  urgency?: number;
  alignment?: number;
  /** Explicit deadline ISO date; used for urgency if present. */
  deadline?: string;
  /** Mark a project excluded from scoring regardless of activity. */
  ignore?: boolean;
}

export interface AnalyzeConfig {
  provider: "ollama" | "openai" | "anthropic";
  model: string; // deep/judgment model
  fastModel: string; // quick triage model
  baseUrl: string;
  apiKey: string | null;
  maxRounds: number; // per-project challenge rounds (>=1)
  numCtx: number;
  temperature: number;
}

export interface ShadowConfig {
  /** Seconds between watch ticks. Default 300 (5min). */
  checkInterval: number;
  /** Fire macOS notifications for urgent events (scatter, quota, overdue). */
  notifyUrgent: boolean;
  /** Min tokens a non-route project must burn to be flagged as "hot". */
  hotProjectThreshold: number;
}

export interface Config {
  paths: {
    projectsDir: string;
    vaultDir: string;
    claudeDir: string;
  };
  analyze: AnalyzeConfig;
  shadow: ShadowConfig;
  /** North-star deadline anchor for urgency when a project has no explicit one. */
  northStarDeadline: string;
  /** A repo idle longer than this (days) is dropped from the active set. */
  activeWindowDays: number;
  subscriptions: Subscription[];
  weights: Weights;
  overrides: Record<string, ProjectOverride>;
}

/** Raw signals collected per project before scoring. */
export interface ProjectSignals {
  name: string;
  path: string;
  isGit: boolean;
  lastCommitAt: Date | null;
  daysSinceCommit: number | null;
  dirtyCount: number;
  aheadCount: number;
  branch: string | null;
  /** Real output tokens attributed to this project (from usage logs, all-time). */
  outputTokens: number;
  /** Output tokens within the engagement window — recent investment signal. */
  recentOutputTokens: number;
  costUsd: number;
  override: ProjectOverride;
  /** Vault-derived hints (used only where no explicit override exists). */
  vault?: {
    title: string;
    status: string;
    tags: string[];
    roi?: number;
    alignment?: number;
  };
  /** AI-analysis judgment (used above Vault, below explicit override). */
  analysis?: {
    roi: number; // 0..10
    percentDone: number; // 0..100
    blocker: string;
    nextAction: string;
    confidence: number;
  };
}

/** A scored project: normalized 0..1 factors + weighted total. */
export interface ScoredProject {
  name: string;
  path: string;
  score: number;
  factors: Record<FactorKey, number>;
  signals: ProjectSignals;
}

// ── Shadow AI types ──

export type ShadowEventKind =
  | "scatter"
  | "quota_critical"
  | "focus_overdue"
  | "hot_project"
  | "sprint_block_done";

export interface ShadowEvent {
  id: string;
  ts: number; // epoch ms
  kind: ShadowEventKind;
  project: string | null;
  message: string;
  detail: Record<string, unknown>;
}

export interface ProjectSprintHistory {
  totalSprintsInRoute: number;
  totalSprintsDeferred: number;
  totalEstTokens: number;
  totalActualTokens: number;
  lastInRouteAt: string | null;
  lastActiveAt: string | null;
}

export interface ShadowState {
  version: number;
  lastCheckMs: number;
  lastSessionMs: number;
  projectHistory: Record<string, ProjectSprintHistory>;
  /** Snapshot of per-project output tokens at last check (for delta computation). */
  lastCheckProjectOutput: Record<string, number>;
  /** Previous detection state: "fidelity" (0-1), "gate" (numeric 0-2), "overdue" (0/1). */
  lastMeta: Record<string, number>;
  pendingEvents: ShadowEvent[];
  /** ISO date key → log line, e.g. "2026-07-04" → "...". Accumulated per day. */
  dailyLog: Record<string, string>;
}

export interface ShadowAdvice {
  hasAdvice: boolean;
  summary: string;
  events: ShadowEvent[];
  generatedAt: string;
}
