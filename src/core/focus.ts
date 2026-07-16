// The commitment loop — the heart of the anti-scatter idea.
// You COMMIT to one project for a bounded horizon with a testable bet and a
// kill criterion. stasis then measures FIDELITY (did your tokens actually go
// there?) and forces an honest verdict at the deadline. Seriousness = tested,
// not declared.
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { STASIS_DIR } from "../config.ts";
import type { UsageEvent } from "../adapters/usage.ts";

export const FOCUS_PATH = join(STASIS_DIR, "focus.json");
const DAY_MS = 86_400_000;

export interface Focus {
  project: string;
  bet: string; // testable hypothesis that makes it a YES
  kill: string; // criterion that makes it a NO
  setAt: string; // ISO
  horizonDays: number;
}

export interface FocusRecord extends Focus {
  endedAt: string;
  verdict: "kept" | "killed" | "pivot";
  note: string;
}

export interface FocusState {
  active: Focus | null;
  history: FocusRecord[];
}

export function loadFocus(): FocusState {
  try {
    if (existsSync(FOCUS_PATH)) return JSON.parse(readFileSync(FOCUS_PATH, "utf8")) as FocusState;
  } catch {
    /* fall through */
  }
  return { active: null, history: [] };
}

export function saveFocus(s: FocusState): void {
  writeFileSync(FOCUS_PATH, JSON.stringify(s, null, 2) + "\n");
}

/** Parse a horizon like "2w", "10d", "3d", "1m" into days. Defaults to 14. */
export function parseHorizon(s: string | undefined): number {
  if (!s) return 14;
  const m = s.match(/^(\d+)\s*([dwm]?)$/i);
  if (!m) return 14;
  const n = Number(m[1]);
  const unit = (m[2] || "d").toLowerCase();
  return unit === "w" ? n * 7 : unit === "m" ? n * 30 : n;
}

export interface FocusStatus {
  focus: Focus;
  daysElapsed: number;
  daysLeft: number;
  overdue: boolean;
  /** Output tokens on the focus project since commitment. */
  focusTokens: number;
  /** Output tokens on everything else since commitment. */
  otherTokens: number;
  /** focusTokens / (focus+other), 0..1; null if not token-traceable / no activity. */
  fidelity: number | null;
  /** Is this bet a code project we can measure fidelity for? Non-git bets (a job,
   *  a course) leave no token trace — for them fidelity is null by design, not scatter. */
  traceable: boolean;
  /** Top projects that stole attention, by tokens, desc. */
  leaks: Array<{ name: string; tokens: number }>;
}

/** Check if a cwd path belongs to a project (matches any path segment exactly). */
function belongsTo(cwd: string, project: string): boolean {
  return cwd.split("/").includes(project);
}

/**
 * Measure fidelity to the commitment from usage events since `setAt`.
 * Note: events are retained ~3 weeks, so very long horizons see a truncated
 * (but still directionally honest) window.
 */
export function focusStatus(
  focus: Focus,
  events: UsageEvent[],
  now = Date.now(),
  opts: { isCodeProject?: boolean } = {},
): FocusStatus {
  // A bet with no project folder (isCodeProject === false) can't be token-traced,
  // so fidelity is null by design and never reported as "scattering". Note the
  // caller decides this from whether the folder exists — NOT from whether it's a
  // git repo: a folder without a repo still receives attributed usage, and
  // calling that "untraceable" would excuse real scatter as a measurement gap.
  const traceable = opts.isCodeProject !== false;
  const setMs = Date.parse(focus.setAt);
  const daysElapsed = Math.max(0, Math.floor((now - setMs) / DAY_MS));
  const daysLeft = focus.horizonDays - daysElapsed;

  const byProject = new Map<string, number>();
  let focusTokens = 0;
  let otherTokens = 0;
  for (const e of events) {
    if (e.ts < setMs) continue;
    const matched = belongsTo(e.cwd, focus.project);
    if (matched) {
      focusTokens += e.outputTokens;
    } else {
      otherTokens += e.outputTokens;
      // Key leaks by cwd basename for readability.
      const leakName = e.cwd.split("/").pop() ?? e.cwd;
      byProject.set(leakName, (byProject.get(leakName) ?? 0) + e.outputTokens);
    }
  }
  const total = focusTokens + otherTokens;
  const leaks = [...byProject.entries()]
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3);

  return {
    focus,
    daysElapsed,
    daysLeft,
    overdue: daysLeft <= 0,
    focusTokens,
    otherTokens,
    fidelity: traceable && total > 0 ? focusTokens / total : null,
    traceable,
    leaks,
  };
}
