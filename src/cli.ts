#!/usr/bin/env bun
// stasis — multi-project scoring & sprint orchestrator (spine).
// Commands: (default dashboard) | score | usage | quota. All accept --json.
import { loadConfig, saveConfig, CONFIG_PATH } from "./config.ts";
import { scanRepos, type GitInfo } from "./adapters/git.ts";
import { parseUsage, type UsageIndex } from "./adapters/usage.ts";
import { loadVault, type VaultInfo } from "./adapters/vault.ts";
import { loadClaudeMem, type MemInfo } from "./adapters/claudemem.ts";
import { scanFs, type FsInfo } from "./adapters/fs.ts";
import { loadPaperclip, type PaperclipInfo } from "./adapters/paperclip.ts";
import { detectCapabilities, hasAI, type Capabilities } from "./adapters/detect.ts";
import { runAnalysis, type AnalyzeTarget, type AnalysisResult } from "./analyze/analyze.ts";
import { makeProvider } from "./analyze/provider.ts";
import { loadAnalysis, saveAnalysis } from "./analyze/store.ts";
import {
  loadFocus,
  saveFocus,
  parseHorizon,
  focusStatus,
  type FocusStatus,
} from "./core/focus.ts";
import { scoreProjects } from "./core/score.ts";
import {
  computeQuota,
  overallGate,
  loadCalib,
  saveCalib,
  calibrate,
  type QuotaStatus,
  type GateLevel,
} from "./core/quota.ts";
import { buildSprint, type SprintPlan } from "./core/sprint.ts";
import type { RoutePlan, RouteBlock } from "./core/route.ts";
import { runWatchTick, runWatchLoop } from "./core/watch.ts";
import {
  loadShadowState,
  loadShadowAdvice,
  defaultShadowState,
  SHADOW_LOG_HEADER,
} from "./adapters/shadow.ts";
import { appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { STASIS_DIR } from "./config.ts";
import type { Config, ProjectSignals, ProjectOverride, ScoredProject } from "./types.ts";

// ---------- tiny formatting helpers ----------
const useColor = (process.stdout.isTTY || process.env.FORCE_COLOR) && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c("1", s);
const dim = (s: string) => c("2", s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);
const red = (s: string) => c("31", s);
const cyan = (s: string) => c("36", s);

const gateColor: Record<GateLevel, (s: string) => string> = { green, yellow, red };

function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
const fmtUsd = (n: number) => "$" + n.toFixed(2);
const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));
const padl = (s: string, w: number) => (s.length >= w ? s : " ".repeat(w - s.length) + s);

// ---------- state assembly ----------
interface State {
  cfg: Config;
  scored: ScoredProject[];
  quota: QuotaStatus[];
  usage: UsageIndex;
}

export function buildSignals(
  repos: GitInfo[],
  usage: UsageIndex,
  vault: Map<string, VaultInfo>,
  analysis: AnalysisResult | null,
  cfg: Config,
  mem: Map<string, MemInfo> = new Map(),
  paperclip: Map<string, PaperclipInfo> = new Map(),
  fsMap: Map<string, FsInfo> = new Map(),
): ProjectSignals[] {
  const byName = new Map<string, { outputTokens: number; recentOutputTokens: number; costUsd: number }>();
  for (const [cwd, pu] of usage.byCwd) {
    // Find the repo whose path is a prefix of cwd — handles subdirectory runs.
    const repo = repos.find((r) => cwd === r.path || cwd.startsWith(r.path + "/"));
    const key = repo?.name ?? cwd.split("/").pop() ?? cwd;
    const acc = byName.get(key) ?? { outputTokens: 0, recentOutputTokens: 0, costUsd: 0 };
    acc.outputTokens += pu.outputTokens;
    acc.recentOutputTokens += pu.recentOutputTokens;
    acc.costUsd += pu.costUsd;
    byName.set(key, acc);
  }
  return repos.map((g) => {
    const u = byName.get(g.name) ?? { outputTokens: 0, recentOutputTokens: 0, costUsd: 0 };
    const v = vault.get(g.name.toLowerCase());
    const m = mem.get(g.name.toLowerCase());
    const pc = paperclip.get(g.name.toLowerCase());
    const aj = analysis?.projects[g.name];
    return {
      name: g.name,
      path: g.path,
      isGit: g.isGit,
      lastCommitAt: g.lastCommitAt,
      daysSinceCommit: g.daysSinceCommit,
      dirtyCount: g.dirtyCount,
      aheadCount: g.aheadCount,
      branch: g.branch,
      outputTokens: u.outputTokens,
      recentOutputTokens: u.recentOutputTokens,
      costUsd: u.costUsd,
      override: cfg.overrides[g.name] ?? {},
      fs: fsMap.get(g.name)
        ? {
            daysSinceModified: fsMap.get(g.name)!.daysSinceModified,
            fileCount: fsMap.get(g.name)!.fileCount,
            sizeBytes: fsMap.get(g.name)!.sizeBytes,
            kinds: fsMap.get(g.name)!.kinds,
          }
        : undefined,
      mem: m ? { obsRecent: m.obsRecent, daysSinceObs: m.daysSinceObs } : undefined,
      paperclip: pc
        ? { percentDone: pc.percentDone, done: pc.done, total: pc.total, open: pc.open }
        : undefined,
      vault: v
        ? { title: v.title, status: v.status, tags: v.tags, roi: v.roi, alignment: v.alignment }
        : undefined,
      analysis: aj
        ? {
            roi: aj.roi,
            percentDone: aj.percentDone,
            alignment: aj.alignment,
            blocker: aj.blocker,
            nextAction: aj.nextAction,
            confidence: aj.confidence,
          }
        : undefined,
    } satisfies ProjectSignals;
  });
}

/**
 * "Active" = touched recently by ANY signal we trust. Git recency is no longer
 * required: a folder with no repo is still live work if its files moved (or if
 * claude-mem saw activity). Without this, non-git projects could never surface.
 */
export function isActive(s: ProjectSignals, cfg: Config): boolean {
  if (Object.keys(s.override).length > 0) return true;
  const w = cfg.activeWindowDays;
  const recency = [
    s.daysSinceCommit,
    s.fs?.daysSinceModified ?? null,
    s.mem?.daysSinceObs ?? null,
  ].filter((d): d is number => d != null);
  return recency.some((d) => d <= w);
}

/**
 * Can we attribute usage to this focus — i.e. is it a real project folder?
 * Deliberately NOT a `.git` test: usage is attributed by working directory, so a
 * folder without a repo is traced just as well. Only a bet with no folder at all
 * (a pure real-world commitment) is untraceable.
 */
function isCodeProject(name: string | null | undefined, cfg: Config): boolean {
  if (!name) return false;
  return existsSync(join(cfg.paths.projectsDir, name));
}

async function loadState(showAll: boolean): Promise<State> {
  const cfg = loadConfig();
  const repos = scanRepos(cfg.paths.projectsDir);
  const [usage, vault, mem, paperclip, fsMap] = await Promise.all([
    parseUsage(cfg.paths.claudeDir),
    Promise.resolve(loadVault(cfg.paths.vaultDir)),
    Promise.resolve(loadClaudeMem(cfg.paths.claudeMemDb, cfg.activeWindowDays)),
    loadPaperclip(repos.map((r) => r.name), cfg.paperclip),
    Promise.resolve(scanFs(cfg.paths.projectsDir)),
  ]);
  // No isGit gate: a project is any folder. Git-less work (a designer's assets,
  // a venture tracked only in Paperclip) is real work and must be rankable.
  let signals = buildSignals(repos, usage, vault, loadAnalysis(), cfg, mem, paperclip, fsMap);
  if (!showAll) signals = signals.filter((s) => isActive(s, cfg));
  const scored = scoreProjects(signals, cfg);
  const quota = computeQuota(cfg.subscriptions, usage.recentEvents, loadCalib());
  return { cfg, scored, quota, usage };
}

// ---------- renderers ----------
function renderQuotaLine(q: QuotaStatus): string {
  const g = gateColor[q.gate];
  if (!q.calibrated) {
    // Honest: no invented cap → show measured burn only, prompt to calibrate.
    return `  ${dim("○")} ${pad(q.subscription, 16)} ${dim("uncalibrated")} — 5h ${fmtTokens(
      q.rolling5h.tokens,
    )} · week ${fmtTokens(q.weekly.tokens)} output tok ${dim(
      `(reset in ${q.resetInDays}d · run \`stasis quota --set\`)`,
    )}`;
  }
  const roll = q.rolling5h.pct != null ? Math.round(q.rolling5h.pct * 100) + "%" : "—";
  const week = q.weekly.pct != null ? Math.round(q.weekly.pct * 100) + "%" : "—";
  return `  ${g("●")} ${pad(q.subscription, 16)} 5h: ${pad(roll, 5)} week: ${pad(week, 5)} ${dim(
    `(${fmtTokens(q.weekly.tokens)}/${fmtTokens(q.weekly.cap ?? 0)} tok week · ${fmtTokens(q.rolling5h.tokens)}/${fmtTokens(q.rolling5h.cap ?? 0)} tok 5h · reset in ${q.resetInDays}d)`,
  )}`;
}

function renderScoreRow(p: ScoredProject, rank: number, nameWidth: number, maxDigits: number): string {
  const s10 = (p.score * 10).toFixed(1);
  const snoozed = p.signals.override.ignore;
  const nameStr = snoozed ? `${dim(pad(p.name, nameWidth))}${dim(" snoozed")}` : bold(pad(p.name, nameWidth));
  const days = p.signals.daysSinceCommit;
  const age = days == null ? "—" : days === 0 ? "today" : `${days}d`;
  const dirty = p.signals.dirtyCount > 0 ? yellow(`${p.signals.dirtyCount}`) + dim(" dirty") : dim("clean");
  const cost = dim(padl(p.signals.costUsd > 0 ? fmtUsd(p.signals.costUsd) : "—", 9));
  const tags = p.signals.vault?.tags.slice(0, 2).join(",");
  const tagHint = tags ? dim("  ◆ " + tags) : "";
  return `  ${padl(String(rank), maxDigits)}. ${nameStr} ${cyan(padl(s10, 4))}  ${pad(
    age,
    6,
  )} ${pad(dirty, 12)} ${cost}${tagHint}`;
}

const modeColor: Record<SprintPlan["mode"], (s: string) => string> = {
  push: green,
  sustain: yellow,
  conserve: red,
};

const kindMark: Record<RouteBlock["kind"], string> = { anchor: "▶", hop: "→", return: "↩" };

/** Keep task lines scannable — one clause, not a paragraph. */
function clip(s: string, n = 78): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut) + "…";
}

function renderRoute(r: RoutePlan): string {
  const lines: string[] = [];
  const mc = modeColor[r.mode];
  if (!r.anchor) return dim("  " + r.note);

  // Header: mode · budget · gate · anchor
  const budget =
    r.budgetTokens != null
      ? `${fmtTokens(r.usedTokens)}/${fmtTokens(r.budgetTokens)} tok`
      : `${fmtTokens(r.usedTokens)} tok`;
  // Be honest about where the minutes come from: your measured throughput, or
  // a default we haven't earned the right to call yours yet.
  const rateNote = r.rate.measured
    ? dim(` (your ${fmtTokens(r.rate.rate)}/min, ${r.rate.samples}d)`)
    : dim(` (est. ${fmtTokens(r.rate.rate)}/min — unmeasured)`);
  lines.push(
    `  ${mc(r.mode.toUpperCase())}  ${dim("·")} budget ${budget} ${dim("·")} ~${r.totalMinutes}m${rateNote} ${dim(
      "·",
    )} anchor ${bold(r.anchor)}`,
  );

  // Ordered blocks.
  r.blocks.forEach((b, i) => {
    const mark = b.kind === "return" ? cyan(kindMark[b.kind]) : kindMark[b.kind];
    const head = `  ${mark} ${padl(String(i + 1), 1)}. ${bold(pad(b.project, 16))} ${clip(b.task)}`;
    const meta = dim(`~${fmtTokens(b.estTokens)} · ${b.estMinutes}m · stop: ${b.stop}`);
    lines.push(head);
    lines.push(`       ${meta}`);
    lines.push(dim(`       why: ${b.why}`));
  });

  // Budget line + deferred.
  if (r.deferred.length) {
    const bl =
      r.budgetTokens != null
        ? `── budget line (${fmtTokens(r.usedTokens)}/${fmtTokens(r.budgetTokens)}) ──`
        : `── deferred ──`;
    lines.push(dim(`  ${bl}`));
    for (const d of r.deferred)
      lines.push(
        dim(`       ${pad(d.project, 16)} ROI ${padl(d.roi.toFixed(1), 4)}  · ${d.reason}`),
      );
  }
  if (r.note) lines.push(dim(`  ${r.note}`));
  return lines.join("\n");
}

function renderSprint(plan: SprintPlan): string {
  const lines: string[] = [];
  if (!plan.focus) return dim("  " + plan.rule);

  // The route is the primary view — the multi-project itinerary.
  lines.push(renderRoute(plan.route));

  // WHY/WHEN/HOW for the anchor, then the deliberate ROI switch menu.
  if (plan.why.length) {
    lines.push("");
    for (const w of plan.why) lines.push(dim(`  ${w}`));
  }
  if (plan.switchOptions.length) {
    lines.push(dim(`  ── or switch anchor by ROI (\`stasis switch <name>\`) ──`));
    for (const o of plan.switchOptions)
      lines.push(
        dim(`     ${pad(o.name, 16)} ROI ${padl(o.roi.toFixed(1), 4)}  ${dim(`· ${o.reason}`)}`),
      );
  }
  return lines.join("\n");
}

// ---------- commands ----------
function hasFlag(args: string[], f: string) {
  return args.includes(f);
}

function printHelp(args: string[], cmd: string, lines: string[]): boolean {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(`stasis ${cmd} — ${lines[0]}`);
    for (const l of lines.slice(1)) console.log(`  ${l}`);
    console.log("");
    return true;
  }
  return false;
}

/** Value after a `--flag`, or undefined. Errors if flag is last. */
function argVal(args: string[], f: string): string | undefined {
  const i = args.indexOf(f);
  if (i < 0) return undefined;
  if (i + 1 >= args.length) {
    console.error(`stasis: error: ${f} requires a value`);
    process.exit(1);
  }
  return args[i + 1];
}

async function cmdDashboard(args: string[]) {
  const state = await loadState(hasFlag(args, "--all"));
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(toJson(state), null, 2));
    return;
  }
  console.log("");
  console.log(bold("🧭 STASIS") + dim("  multi-project orchestrator"));
  // Active commitment leads the dashboard — it frames everything below it.
  const focus = loadFocus();
  if (focus.active) {
    const usage = await parseUsage(state.cfg.paths.claudeDir);
    console.log(bold("\n[ FOCUS ]"));
    console.log(
      renderFocusStatus(
        focusStatus(focus.active, usage.recentEvents, Date.now(), {
          isCodeProject: isCodeProject(focus.active.project, state.cfg),
        }),
      ),
    );
  }
  console.log(bold("\n[ QUOTA ]"));
  if (state.quota.length === 0) console.log(dim("  no subscriptions configured"));
  for (const q of state.quota) console.log(renderQuotaLine(q));
  console.log(bold("\n[ SCORES ]") + dim("  (active projects — `--all` for every repo)"));
  const top = state.scored.slice(0, 12);
  const nameWidth = Math.min(30, Math.max(4, ...top.map((p) => p.name.length)));
  const maxDigits = String(top.length).length;
  top.forEach((p, i) => console.log(renderScoreRow(p, i + 1, nameWidth, maxDigits)));
  if (state.scored.length > top.length)
    console.log(dim(`  … ${state.scored.length - top.length} more`));
  // Self-guidance: without AI analysis, roi/alignment are neutral — say so.
  if (!loadAnalysis())
    console.log(
      dim("  ⓘ roi/alignment are neutral — run `stasis analyze` (needs a model) for real judgments"),
    );
  console.log(bold("\n[ TODAY ]"));
  console.log(
    renderSprint(
      buildSprint(state.scored, state.quota, state.cfg.weights, {
        events: state.usage.recentEvents,
        focus: focus.active ? { project: focus.active.project, bet: focus.active.bet } : null,
        focusIsCode: isCodeProject(focus.active?.project, state.cfg),
      }),
    ),
  );
  console.log("");
}

async function cmdScore(args: string[]) {
  if (printHelp(args, "score", ["ranked project scores", "--all     include inactive projects", "--json    JSON output"])) return;
  const state = await loadState(hasFlag(args, "--all"));
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(state.scored.map(scoredJson), null, 2));
    return;
  }
  console.log(bold("\n  #  project                score   age    dirty        cost"));
  const nameWidth = Math.min(30, Math.max(4, ...state.scored.map((p) => p.name.length)));
  const maxDigits = String(state.scored.length).length;
  state.scored.forEach((p, i) => console.log(renderScoreRow(p, i + 1, nameWidth, maxDigits)));
  console.log("");
}

async function cmdUsage(args: string[]) {
  if (printHelp(args, "usage", ["tokens + cost from Claude Code logs", "--project <name>  filter by project", "--json           JSON output"])) return;
  const cfg = loadConfig();
  const usage = await parseUsage(cfg.paths.claudeDir);
  const projFlag = argVal(args, "--project");
  const rows = [...usage.byCwd.values()]
    .filter((u) => (hasFlag(args, "--project") ? u.name === projFlag : true))
    .sort((a, b) => b.costUsd - a.costUsd);
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  let totalCost = 0;
  let totalOut = 0;
  console.log(bold("\n  project                    out      cacheRead      cost"));
  for (const u of rows.slice(0, 25)) {
    totalCost += u.costUsd;
    totalOut += u.outputTokens;
    console.log(
      `  ${pad(u.name, 24)} ${padl(fmtTokens(u.outputTokens), 7)}  ${padl(
        fmtTokens(u.cacheReadTokens),
        10,
      )}  ${padl(fmtUsd(u.costUsd), 9)}`,
    );
  }
  for (const u of rows.slice(25)) {
    totalCost += u.costUsd;
    totalOut += u.outputTokens;
  }
  console.log(dim(`  ${"-".repeat(54)}`));
  console.log(
    `  ${bold(pad("TOTAL (all-time)", 24))} ${padl(fmtTokens(totalOut), 7)}  ${padl("", 10)}  ${padl(
      fmtUsd(totalCost),
      9,
    )}\n`,
  );
}

/** Parse `week=68 5h=42` style tokens into a reading. */
function parseSet(args: string[]): { week?: number; fiveH?: number } {
  const r: { week?: number; fiveH?: number } = {};
  for (const a of args) {
    const m = a.match(/^(week|5h)=(\d+(?:\.\d+)?)%?$/i);
    if (!m) continue;
    const v = Number(m[2]);
    if (m[1]!.toLowerCase() === "week") r.week = v;
    else r.fiveH = v;
  }
  return r;
}

async function cmdQuota(args: string[]) {
  if (printHelp(args, "quota", ["estimated 5h + weekly burn vs caps", "--set week=<pct> 5h=<pct>  calibrate from /usage", "--json                    JSON output"])) return;
  const cfg = loadConfig();
  const usage = await parseUsage(cfg.paths.claudeDir);
  const sub = cfg.subscriptions[0];

  if (hasFlag(args, "--set")) {
    const reading = parseSet(args);
    if (reading.week == null && reading.fiveH == null) {
      console.error(
        "stasis: usage: stasis quota --set week=<pct> 5h=<pct>   (read them from Claude Code /usage)",
      );
      process.exit(1);
    }
    const calib = calibrate(usage.recentEvents, reading, sub?.resetDay ?? "Monday");
    saveCalib(calib);
    console.log(bold("\n  ✓ calibrated from your /usage reading"));
    if (calib.weekCap)
      console.log(`  weekly cap  ≈ ${fmtTokens(calib.weekCap)} output tok  ${dim("(100%)")}`);
    if (calib.fiveHCap)
      console.log(`  5h cap      ≈ ${fmtTokens(calib.fiveHCap)} output tok  ${dim("(100%)")}`);
    if (!calib.weekCap && !calib.fiveHCap)
      console.log(dim("  (no burn measured in those windows yet — try again after some work)"));
    console.log("");
    return;
  }

  const quota = computeQuota(cfg.subscriptions, usage.recentEvents, loadCalib());
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(quota, null, 2));
    return;
  }
  console.log(bold("\n[ QUOTA ]"));
  for (const q of quota) console.log(renderQuotaLine(q));
  if (!quota.some((q) => q.calibrated)) {
    console.log(
      dim(
        `\n  Open Claude Code \`/usage\`, then anchor real caps:\n    stasis quota --set week=<pct> 5h=<pct>\n`,
      ),
    );
  }
}

async function cmdSprint(args: string[]) {
  if (printHelp(args, "sprint", ["routed multi-project itinerary (anchor → hops → return)", "--hours <N>  cap the route by wall-clock hours", "--all        include inactive projects", "--json       JSON output"])) return;
  const state = await loadState(hasFlag(args, "--all"));
  const hoursArg = argVal(args, "--hours");
  const hours = hoursArg != null && !Number.isNaN(Number(hoursArg)) ? Number(hoursArg) : undefined;
  const focus = loadFocus().active;
  const plan = buildSprint(state.scored, state.quota, state.cfg.weights, {
    events: state.usage.recentEvents,
    focus: focus ? { project: focus.project, bet: focus.bet } : null,
    focusIsCode: isCodeProject(focus?.project, state.cfg),
    hours,
  });
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(bold("\n[ SPRINT ]"));
  console.log(renderSprint(plan));
  console.log("");
}

const SWITCH_LOG = join(STASIS_DIR, "switch-log.jsonl");

/** Count switch-log entries at or after a timestamp. */
function switchesSince(sinceMs: number): number {
  if (!existsSync(SWITCH_LOG)) return 0;
  let n = 0;
  try {
    for (const line of readFileSync(SWITCH_LOG, "utf8").split("\n")) {
      if (!line) continue;
      const ts = Date.parse(JSON.parse(line).at ?? "");
      if (!Number.isNaN(ts) && ts >= sinceMs) n++;
    }
  } catch {
    /* best-effort */
  }
  return n;
}

async function cmdSwitch(args: string[]) {
  const nowIso = new Date().toISOString();
  const target = args.find((a) => !a.startsWith("-"));

  // No target → ROI-ranked menu among ACTIVE projects (deliberate switch).
  if (!target) {
    const active = await loadState(hasFlag(args, "--all"));
    const focus = loadFocus().active;
    const plan = buildSprint(active.scored, active.quota, active.cfg.weights, {
      events: active.usage.recentEvents,
      focus: focus ? { project: focus.project, bet: focus.bet } : null,
      focusIsCode: isCodeProject(focus?.project, active.cfg),
    });
    console.log(
      bold("\n[ SWITCH BY ROI ]") + dim(`  current focus: ${active.scored[0]?.name ?? "—"}`),
    );
    for (const o of plan.switchOptions)
      console.log(
        `  ${pad(o.name, 20)} ROI ${padl(o.roi.toFixed(1), 4)}  score ${padl(
          o.score.toFixed(1),
          4,
        )}  ${dim("· " + o.reason)}`,
      );
    console.log(dim(`\n  Pick one: stasis switch <name>  ·  all repos: stasis switch --all\n`));
    return;
  }

  const state = await loadState(true); // resolve a named target against every repo
  const focus = state.scored[0];

  const to = state.scored.find((p) => p.name === target);
  if (!to) {
    console.error(`stasis: error: no scored project named "${target}" (try \`stasis score --all\`)`);
    process.exit(1);
  }

  // Advisory only — never blocks. Warn on a downgrade, log the switch, show the tax.
  console.log("");
  if (focus && to.name !== focus.name && to.score < focus.score) {
    console.log(
      `  ${yellow("⚠ context switch")}: ${bold(to.name)} ${dim(
        `(${(to.score * 10).toFixed(1)})`,
      )} is below your top focus ${bold(focus.name)} ${dim(`(${(focus.score * 10).toFixed(1)})`)}.`,
    );
    console.log(dim(`  Cold-starting a second repo re-ingests context. Sure it's worth it?`));
  } else {
    console.log(`  → switching to ${bold(to.name)} ${dim(`(${(to.score * 10).toFixed(1)})`)}`);
  }

  try {
    appendFileSync(SWITCH_LOG, JSON.stringify({ at: nowIso, to: to.name }) + "\n");
  } catch {
    /* best-effort log */
  }
  const weekAgo = Date.parse(nowIso) - 7 * 86_400_000;
  const n = switchesSince(weekAgo);
  console.log(dim(`  ${n} project switch${n === 1 ? "" : "es"} logged in the last 7 days.`));
  console.log("");
}

async function cmdAnalyze(args: string[]) {
  if (printHelp(args, "analyze", [
    "AI reads each project → structured ROI / blocker / next action",
    "--fast         use smaller model (faster, less accurate)",
    "--project <n>  analyze a single project",
    "--all          analyze every repo (not just active)",
    "--no-global    skip portfolio-level analysis",
    "--json         JSON output",
  ])) return;
  const cfg = loadConfig();
  const projFlag = argVal(args, "--project");
  const useFast = hasFlag(args, "--fast");
  if (useFast) cfg.analyze.model = cfg.analyze.fastModel;

  // Provider reachability first — fail loud with a hint.
  const provider = makeProvider(cfg.analyze);
  if (!(await provider.ping())) {
    console.error(
      `stasis: analyze provider "${provider.label}" not reachable.\n` +
        (cfg.analyze.provider === "ollama"
          ? `  Start it:  ollama serve   (and \`ollama pull ${cfg.analyze.model}\`)`
          : `  Set analyze.apiKey in ${CONFIG_PATH}`),
    );
    process.exit(1);
  }

  // Choose targets: one project, every folder, or the active set (default).
  // Not git-only — the evidence collector degrades to README + file tree, so a
  // git-less venture can still be judged instead of sitting at a neutral 0.5.
  const repos = scanRepos(cfg.paths.projectsDir);
  const fsMap = scanFs(cfg.paths.projectsDir);
  const vault = loadVault(cfg.paths.vaultDir);
  const recentlyTouched = (name: string, daysSinceCommit: number | null) => {
    const days = [daysSinceCommit, fsMap.get(name)?.daysSinceModified ?? null].filter(
      (d): d is number => d != null,
    );
    return days.some((d) => d <= cfg.activeWindowDays);
  };
  let chosen = repos;
  if (projFlag) chosen = repos.filter((r) => r.name === projFlag);
  else if (!hasFlag(args, "--all"))
    chosen = repos.filter((r) => recentlyTouched(r.name, r.daysSinceCommit));

  if (chosen.length === 0) {
    console.error("stasis: error: no matching projects to analyze.");
    process.exit(1);
  }

  const targets: AnalyzeTarget[] = chosen.map((r) => {
    const v = vault.get(r.name.toLowerCase());
    const f = fsMap.get(r.name);
    return {
      name: r.name,
      dir: r.path,
      vaultNote: v ? `${v.title} — tags:[${v.tags.join(",")}] status:${v.status}` : undefined,
      isGit: r.isGit,
      kinds: f?.kinds,
      daysSinceModified: f?.daysSinceModified ?? null,
    };
  });

      console.error(
        dim(
          `\n  Decide honestly: did the bet hold?\n  stasis focus review --verdict kept, killed, or pivot --note "what happened"\n`,
        ),
      );

  // Merge with any prior analysis so a targeted run doesn't wipe the rest.
  const prior = loadAnalysis();
  const result: AnalysisResult = await runAnalysis(cfg.analyze, targets, cfg.goal.statement, {
    global: !projFlag && !hasFlag(args, "--no-global"),
    onProgress: (m) => process.stderr.write(dim(`  ${m}\n`)),
  });
  if (prior) {
    result.projects = { ...prior.projects, ...result.projects };
    if (!result.global) result.global = prior.global;
  }
  saveAnalysis(result);

  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  renderAnalysis(result, targets.map((t) => t.name));
}

function renderAnalysis(a: AnalysisResult, focusNames: string[]) {
  console.log(bold(`\n[ ANALYSIS ]`) + dim(`  ${a.provider} · ${a.generatedAt.slice(0, 16)}`));
  const rows = focusNames
    .map((n) => ({ n, j: a.projects[n] }))
    .filter((r) => r.j)
    .sort((x, y) => y.j!.roi - x.j!.roi);
  for (const { n, j } of rows) {
    console.log(
      `  ${bold(pad(n, 20))} ROI ${cyan(padl(String(j!.roi), 2))}  done ${padl(
        j!.percentDone + "%",
        4,
      )}  ${dim(`conf ${(j!.confidence * 100).toFixed(0)}% · ${j!.rounds}r`)}`,
    );
    console.log(dim(`     blocker: ${j!.blocker}`));
  }
  if (a.global) {
    console.log(bold("\n[ PORTFOLIO ]"));
    if (a.global.focusRecommendation) console.log(`  focus: ${a.global.focusRecommendation}`);
    if (a.global.insight) console.log(dim(`  insight: ${a.global.insight}`));
    for (const o of a.global.overlaps.slice(0, 4)) console.log(dim(`  overlap: ${o}`));
  }
  console.log(dim(`\n  Scores now use these judgments. Run \`stasis\` to see the ranking.\n`));
}

function renderFocusStatus(st: FocusStatus): string {
  const f = st.focus;
  const lines: string[] = [];
  const fid = st.fidelity;
  const when = st.overdue
    ? red(`OVERDUE by ${-st.daysLeft}d — review it`)
    : dim(`day ${st.daysElapsed}/${f.horizonDays}, ${st.daysLeft}d left`);
  lines.push(`  🎯 ${bold(f.project)}  ${when}`);
  lines.push(`  bet:  ${f.bet}`);
  lines.push(`  kill: ${dim(f.kill)}`);
  if (!st.traceable) {
    // Non-code bet: no token trace, so no fidelity — judged at the verdict.
    lines.push(`  on-target: ${dim("not token-traced (non-code bet) — judged at the verdict")}`);
    if (st.leaks.length) {
      const leak = st.leaks.map((l) => `${l.name} ${fmtTokens(l.tokens)}`).join(", ");
      lines.push(dim(`  meanwhile you coded: ${leak}`));
    }
  } else {
    const fidStr =
      fid == null
        ? dim("no activity yet")
        : (fid >= 0.6 ? green : fid >= 0.4 ? yellow : red)(`${Math.round(fid * 100)}% on target`);
    lines.push(
      `  on-target: ${fidStr}${fid != null && fid < 0.6 ? red("  ⚠ going off track") : ""}`,
    );
    if (st.leaks.length && (fid == null || fid < 0.8)) {
      const leak = st.leaks.map((l) => `${l.name} ${fmtTokens(l.tokens)}`).join(", ");
      lines.push(dim(`  off-focus work: ${leak}`));
    }
  }
  if (st.overdue)
    lines.push(
      `  ${bold("→ verdict time:")} stasis focus review --verdict kept, killed, or pivot --note "…"`,
    );
  return lines.join("\n");
}

const WATCH_PID_PATH = join(STASIS_DIR, "watch.pid");

function startDaemon(): void {
  const self = process.argv[1] ?? "src/cli.ts";
  // If running from the compiled binary, use it directly.
  // Otherwise fall back to `bun run src/cli.ts`.
  const isBinary = !self.endsWith(".ts");
  const child = isBinary
    ? spawn(self, ["watch", "--daemon-child"], { stdio: "ignore", detached: true, env: { ...process.env } })
    : spawn("bun", ["run", self, "watch", "--daemon-child"], { stdio: "ignore", detached: true, env: { ...process.env } });
  child.unref();
  const pid = child.pid;
  if (pid == null) {
    console.error(dim("  failed to start daemon\n"));
    process.exit(1);
  }
  writeFileSync(WATCH_PID_PATH, String(pid));
  console.log(dim(`  stasis watch daemon started (pid ${pid})\n`));
  process.exit(0);
}

function stopDaemon(): void {
  try {
    const pid = Number(readFileSync(WATCH_PID_PATH, "utf8").trim());
    process.kill(pid, "SIGTERM");
    unlinkSync(WATCH_PID_PATH);
    console.log(dim("  ✓ stasis watch daemon stopped\n"));
  } catch {
    console.error(dim("  no running daemon found\n"));
  }
  process.exit(0);
}

async function cmdWatch(args: string[]) {
  if (printHelp(args, "watch", [
    "background monitor — detects scatter, quota, overdue, hot projects",
    "--daemon     fork to background",
    "--stop       kill the daemon",
    "--status     show shadow state + pending advice",
    "--once       single check, print advice, exit",
  ])) return;
  const cfg = loadConfig();

  if (hasFlag(args, "--stop")) return stopDaemon();
  if (hasFlag(args, "--daemon")) return startDaemon();

  // Show current shadow state
  if (hasFlag(args, "--status")) {
    const state = loadShadowState();
    const advice = loadShadowAdvice();
    console.log(bold("\n[ SHADOW STATUS ]"));
    if (state.lastCheckMs > 0)
      console.log(dim(`  last check: ${new Date(state.lastCheckMs).toISOString().slice(0, 19)}`));
    else console.log(dim("  never run"));
    console.log(dim(`  projects tracked: ${Object.keys(state.projectHistory).length}`));
    console.log(dim(`  pending events: ${state.pendingEvents.length}`));

    if (advice?.hasAdvice) {
      console.log(bold("\n[ ADVICE ]"));
      console.log(advice.summary);
    }

    // Show today's daily log
    const today = new Date().toISOString().slice(0, 10);
    if (state.dailyLog[today]) {
      console.log(bold(`\n[ LOG — ${today} ]`));
      console.log(dim(state.dailyLog[today]));
    } else {
      console.log(dim(`\n  no events today`));
    }
    console.log("");
    return;
  }

  // --once: single tick
  if (hasFlag(args, "--once")) {
    console.log(dim("  shadow watch — one tick\n"));
    const state = loadShadowState();
    const result = await runWatchTick(cfg, state, Date.now());
    if (result.advice?.hasAdvice) {
      console.log(result.advice.summary);
    } else {
      console.log(dim("  no events detected\n"));
    }
    return;
  }

  // --daemon-child: internal flag for the forked daemon process
  if (hasFlag(args, "--daemon-child")) {
    // Redirect all output to /dev/null — this is the background process
    // Run the watch loop
    await runWatchLoop(cfg, {
      intervalMs: cfg.shadow.checkInterval * 1000,
      onTick: (result, tick) => {
        if (tick % 12 === 0) {
          // Log progress every ~hour (12 ticks × 5min)
          const now = new Date().toISOString().slice(11, 19);
          appendFileSync(join(STASIS_DIR, "watch-daemon.log"), `[${now}] tick ${tick}: ${result.events.length} events\n`);
        }
      },
      onError: (err) => {
        const now = new Date().toISOString();
        appendFileSync(join(STASIS_DIR, "watch-daemon.log"), `[${now}] ERROR: ${err.message}\n`);
      },
    });
    return;
  }

  // Default foreground mode
  console.log(bold(`\n🧍 stasis watch  ${dim("— Ctrl+C to stop")}\n`));
  const state = loadShadowState();
  let tick = 0;

  const doTick = async () => {
    tick++;
    try {
      const result = await runWatchTick(cfg, state, Date.now());
      // state is mutated in place
      const now = new Date().toISOString().slice(11, 19);
      const ev = result.events.length;
      const summary = ev > 0
        ? `${ev} event${ev > 1 ? "s" : ""}`
        : "all clear";
      if (tick === 1 || ev > 0) {
        console.log(`  [${now}] tick #${tick} — ${summary}`);
        if (result.advice?.hasAdvice) {
          for (const line of result.advice.summary.split("\n")) {
            console.log(dim(`    ${line}`));
          }
        }
      } else if (tick % 6 === 0) {
        // Heartbeat every ~30s (6 × 5s intervals) so the terminal doesn't look frozen
        process.stderr.write(dim("."));
      }
    } catch (err) {
      console.error(red(`  [${new Date().toISOString().slice(11, 19)}] error: ${(err as Error).message}`));
    }
  };

  await doTick();
  setInterval(doTick, cfg.shadow.checkInterval * 1000);

  // Keep alive
  await new Promise<never>(() => {});
}

async function cmdFocus(args: string[]) {
  if (printHelp(args, "focus", [
    "your active commitment + fidelity (anti-scatter)",
    "set <project> --for 2w --bet <bet> --kill <kill>    commit to a bet",
    "review --verdict kept, killed, or pivot --note <text>     close the current bet",
    "clear       abandon focus without recording a verdict",
    "--json      JSON output",
  ])) return;
  const sub = args[0] && !args[0].startsWith("-") ? args[0] : "status";
  const state = loadFocus();
  const cfg = loadConfig();

  if (sub === "set") {
    const project = args[1] && !args[1].startsWith("-") ? args[1] : argVal(args, "--project");
    if (!project) {
      console.error('stasis: usage: stasis focus set <project> --for 2w --bet "…" --kill "…"');
      process.exit(1);
    }
    const repos = scanRepos(cfg.paths.projectsDir);
    if (!repos.some((r) => r.name === project)) {
      console.error(`stasis: error: no project "${project}" under ${cfg.paths.projectsDir}`);
      process.exit(1);
    }
    if (state.active && state.active.project !== project) {
      console.log(
        yellow(
          `  ⚠ replacing active focus (${state.active.project}) without a verdict. Its record is lost.`,
        ),
      );
    }
    state.active = {
      project,
      bet: argVal(args, "--bet") ?? "(no bet stated)",
      kill: argVal(args, "--kill") ?? "(no kill criterion)",
      setAt: new Date().toISOString(),
      horizonDays: parseHorizon(argVal(args, "--for")),
    };
    saveFocus(state);
    console.log(bold(`\n  🎯 committed to ${project} for ${state.active.horizonDays}d`));
    console.log(`  bet:  ${state.active.bet}`);
    console.log(dim(`  kill: ${state.active.kill}\n`));
    return;
  }

  if (sub === "review") {
    if (!state.active) {
      console.error("stasis: error: no active focus to review.");
      process.exit(1);
    }
    const verdict = (argVal(args, "--verdict") ?? "").toLowerCase();
    if (!["kept", "killed", "pivot"].includes(verdict)) {
      // Show the judgment prompt instead of recording.
      const usage = await parseUsage(cfg.paths.claudeDir);
      const st = focusStatus(state.active, usage.recentEvents, Date.now(), {
        isCodeProject: isCodeProject(state.active.project, cfg),
      });
      console.log(bold("\n[ VERDICT ]"));
      console.log(renderFocusStatus(st));
      console.log(
        dim(
          `\n  Decide honestly: did the bet hold?\n  stasis focus review --verdict kept, killed, or pivot --note "what happened"\n`,
        ),
      );
      return;
    }
    state.history.unshift({
      ...state.active,
      endedAt: new Date().toISOString(),
      verdict: verdict as "kept" | "killed" | "pivot",
      note: argVal(args, "--note") ?? "",
    });
    const closed = state.active.project;
    state.active = null;
    saveFocus(state);
    console.log(bold(`\n  ✓ ${closed} → ${verdict}. Recorded. Pick your next bet with /stasis.\n`));
    return;
  }

  if (sub === "clear") {
    state.active = null;
    saveFocus(state);
    console.log(dim("\n  focus cleared (no verdict recorded)\n"));
    return;
  }

  // status (default)
  if (hasFlag(args, "--json")) {
    const usage = await parseUsage(cfg.paths.claudeDir);
    const st = state.active
      ? focusStatus(state.active, usage.recentEvents, Date.now(), {
          isCodeProject: isCodeProject(state.active.project, cfg),
        })
      : null;
    console.log(JSON.stringify({ active: st, history: state.history }, null, 2));
    return;
  }
  console.log(bold("\n[ FOCUS ]"));
  if (!state.active) {
    console.log(dim("  No active commitment. This is where the scatter starts."));
    console.log(dim("  Decide your bet with the coach:  /stasis"));
    console.log(dim('  Or set directly:  stasis focus set <project> --for 2w --bet "…" --kill "…"'));
    if (state.history.length)
      console.log(dim(`  (${state.history.length} past commitment${state.history.length === 1 ? "" : "s"} on record)`));
    console.log("");
    return;
  }
  const usage = await parseUsage(cfg.paths.claudeDir);
  console.log(
    renderFocusStatus(
      focusStatus(state.active, usage.recentEvents, Date.now(), {
        isCodeProject: isCodeProject(state.active.project, cfg),
      }),
    ),
  );
  console.log("");
}

// ---------- json shapes ----------
function scoredJson(p: ScoredProject) {
  return {
    name: p.name,
    path: p.path,
    score: Number((p.score * 10).toFixed(2)),
    factors: p.factors,
    daysSinceCommit: p.signals.daysSinceCommit,
    dirtyCount: p.signals.dirtyCount,
    aheadCount: p.signals.aheadCount,
    costUsd: Number(p.signals.costUsd.toFixed(2)),
    isGit: p.signals.isGit,
    fs: p.signals.fs ?? null,
    mem: p.signals.mem ?? null,
    paperclip: p.signals.paperclip ?? null,
    vault: p.signals.vault
      ? { note: p.signals.vault.title, status: p.signals.vault.status, tags: p.signals.vault.tags }
      : null,
  };
}
function toJson(state: State) {
  return {
    gate: overallGate(state.quota),
    quota: state.quota,
    projects: state.scored.map(scoredJson),
  };
}

async function cmdSnooze(args: string[]) {
  const cfg = loadConfig();

  if (hasFlag(args, "--list")) {
    const entries = Object.entries(cfg.overrides) as [string, ProjectOverride][];
    const snoozed = entries
      .filter(([, o]) => o.ignore)
      .map(([name]) => name)
      .sort();
    console.log(bold("\n[ SNOOZED ]"));
    if (snoozed.length === 0) console.log(dim("  no projects snoozed\n"));
    else for (const n of snoozed) console.log(`  ${dim("-")} ${bold(n)}`);
    console.log("");
    return;
  }

  if (hasFlag(args, "--clear")) {
    for (const [name, o] of Object.entries(cfg.overrides) as [string, ProjectOverride][]) {
      if (o.ignore) delete cfg.overrides[name];
    }
    saveConfig(cfg);
    console.log(dim("\n  ✓ all projects unsnoozed\n"));
    return;
  }

  const project = args.find((a) => !a.startsWith("-"));
  if (!project) {
    console.error("stasis: usage: stasis snooze <project>");
    process.exit(1);
  }
  const repos = scanRepos(cfg.paths.projectsDir);
  if (!repos.some((r) => r.name === project)) {
    const vault = loadVault(cfg.paths.vaultDir);
    const known = [...new Set(repos.map((r) => r.name))].sort();
    console.error(
      `stasis: no project "${project}" under ${cfg.paths.projectsDir}\n` +
        dim(`  known: ${known.slice(0, 20).join(", ")}${known.length > 20 ? ", …" : ""}`),
    );
    process.exit(1);
  }

  cfg.overrides[project] = { ...cfg.overrides[project], ignore: true };
  saveConfig(cfg);
  console.log(bold(`\n  ${project} snoozed`) + dim("  (scored but excluded from routing)"));
  console.log(dim(`  unsnooze: stasis unsnooze ${project}\n`));
}

async function cmdUnsnooze(args: string[]) {
  const cfg = loadConfig();
  const project = args.find((a) => !a.startsWith("-"));
  if (!project) {
    console.error("stasis: usage: stasis unsnooze <project>");
    process.exit(1);
  }
  if (!cfg.overrides[project]?.ignore) {
    console.error(`stasis: error: "${project}" is not snoozed`);
    process.exit(1);
  }
  delete cfg.overrides[project];
  saveConfig(cfg);
  console.log(bold(`\n  ✓ ${project} unsnoozed`) + dim("  (back in routing)\n"));
}

// ---------- onboarding ----------
/** Ask one question with a default; returns the default on non-TTY (piped) runs. */
function ask(q: string, def: string, tty: boolean): string {
  if (!tty) return def;
  const ans = prompt(`  ${q} ${dim(`[${def || "none"}]`)}`);
  return ans && ans.trim() ? ans.trim() : def;
}

/** One-line capability readout for the user. */
function capLine(c: Capabilities): string {
  const mark = (on: boolean, label: string) => (on ? green(label) : dim(`${label}✗`));
  const ai = c.ollama ? "AI(ollama)" : c.apiKey ? "AI(api)" : "AI";
  return [
    mark(c.git, "git"),
    mark(c.claudeUsage, "claude-logs"),
    mark(hasAI(c), ai),
    mark(c.vault, "vault"),
    mark(c.paperclip, "paperclip"),
  ].join(dim(" · "));
}

/** An API key gets AI working with zero install — the only realistic path for
 *  someone who isn't going to set up a local model. Shape tells us the vendor. */
function providerForKey(key: string): { provider: "anthropic" | "openai"; model: string; fastModel: string } | null {
  if (key.startsWith("sk-ant-"))
    return { provider: "anthropic", model: "claude-sonnet-5", fastModel: "claude-haiku-4-5-20251001" };
  if (key.startsWith("sk-")) return { provider: "openai", model: "gpt-4o", fastModel: "gpt-4o-mini" };
  return null;
}

/** Guided first-run setup. Re-runnable via `stasis init`. */
async function cmdInit(args: string[]) {
  if (printHelp(args, "init", ["guided first-run setup (folder + your goal); re-run anytime"])) return;
  const tty = !!process.stdin.isTTY;
  let cfg = loadConfig(); // seeds a default file if none, then we overwrite with answers
  console.log(bold("\n🧭 stasis setup") + dim("  — a few quick questions\n"));

  // 1. The folder first: everything else (including how we talk) depends on it.
  const dir = ask("Which folder holds your projects?", cfg.paths.projectsDir, tty);
  saveConfig({ ...cfg, paths: { ...cfg.paths, projectsDir: dir } });
  cfg = loadConfig(); // re-load so the path is home-expanded before we look at it

  // 2. Look before speaking: a folder of documents shouldn't be asked about repos.
  const caps = await detectCapabilities(cfg);
  const dev = caps.code || caps.git;

  const statement = ask(
    dev ? "Your goal, in one sentence?" : "What are you trying to achieve? (one sentence)",
    cfg.goal.statement,
    tty,
  );
  const deadlineRaw = ask("Target date? (YYYY-MM-DD, blank = none)", cfg.goal.deadline ?? "", tty);
  const deadline = deadlineRaw.trim() ? deadlineRaw.trim() : null;
  cfg = { ...cfg, goal: { statement, deadline } };

  // 3. AI is what turns a bare recency list into real judgment. For someone who
  //    isn't going to install a local model, a pasted key is the whole path.
  if (!hasAI(caps)) {
    console.log(
      dim(
        dev
          ? "\n  No AI configured. Without it, ranking is git/recency only — roi and fit stay neutral."
          : "\n  Without AI, stasis can only show you which folders are freshest.",
      ),
    );
    console.log(
      dim(
        dev
          ? "  Add a local model (Ollama) later, or paste an API key now for judgments on any folder."
          : "  Paste an API key to have it read your work and tell you what's worth your time.",
      ),
    );
    const key = ask("API key? (Anthropic or OpenAI, blank = skip)", "", tty).trim();
    if (key) {
      const p = providerForKey(key);
      if (p) {
        cfg = { ...cfg, analyze: { ...cfg.analyze, ...p, apiKey: key } };
        console.log(dim(`  ✓ using ${p.provider} (${p.model})`));
      } else {
        console.log(yellow("  ⚠ unrecognized key format — skipped. Set analyze.apiKey in the config."));
      }
    }
  }

  saveConfig(cfg);
  const finalCaps = await detectCapabilities(loadConfig());
  console.log(bold("\n  Detected:  ") + capLine(finalCaps));

  if (hasAI(finalCaps)) {
    const yes = ask("Read your projects now? (y/N)", "N", tty).toLowerCase().startsWith("y");
    if (yes) await cmdAnalyze([]);
  }
  console.log(dim(`\n  Saved to ${CONFIG_PATH}. Run \`stasis\` for your ranking.\n`));
}

// ---------- main ----------
const HELP = `stasis — multi-project scoring & sprint orchestrator

  stasis init                guided setup: your projects folder + your goal
  stasis                     dashboard: quota + ranked scores + today's rec
  stasis score [--all]       ranked project scores with factor breakdown
  stasis usage [--project X] real tokens + cost from Claude Code logs
  stasis quota               estimated 5h + weekly burn vs caps
  stasis sprint [--hours N]  routed multi-project itinerary (anchor → ROI hops → close), quota-bounded
  stasis switch [<project>]  ROI switch menu / advisory switch + log
  stasis analyze [--fast]    AI reads each project → structured ROI/%done/blocker
  stasis focus               your active commitment + fidelity (anti-scatter)
  stasis focus set <p> --for 2w --bet "…" --kill "…"
  stasis focus review --verdict kept, killed, or pivot --note "…"
  stasis snooze <project>    exclude from routing (still scored; set aside for later)
  stasis snooze --list       show snoozed projects
  stasis snooze --clear      unsnooze all projects
  stasis unsnooze <project>  restore to routing
  stasis watch               background monitor (foreground, Ctrl+C)
  stasis watch --daemon      fork to background
  stasis watch --once        single check, print advice, exit
  stasis watch --status      show shadow state + pending advice
  stasis watch --stop        kill the daemon

  flags: --json  --all  --project <name>  --fast  --no-global  --hours <N>
  config: ${CONFIG_PATH}`;

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];
  let cmd: string | undefined;
  let rest: string[];
  if (first === "-h" || first === "--help") {
    cmd = "help";
    rest = [];
  } else if (first === undefined || first.startsWith("-")) {
    cmd = undefined; // default dashboard; leading flags stay in rest
    rest = argv;
  } else {
    cmd = first;
    rest = argv.slice(1);
  }
  try {
    // First run (no config yet): guide the user through setup before anything else.
    // `stasis init` and `help` are exempt (they'd be redundant / need no config).
    if (!existsSync(CONFIG_PATH) && cmd !== "init" && cmd !== "help") {
      await cmdInit([]);
      // For a bare `stasis`, fall through to the dashboard; for a specific
      // command, stop here — the user can now re-run it against the new config.
      if (cmd !== undefined && cmd !== "dash" && cmd !== "dashboard") return;
    }
    switch (cmd) {
      case undefined:
      case "dash":
      case "dashboard":
        await cmdDashboard(rest);
        break;
      case "init":
        await cmdInit(rest);
        break;
      case "score":
        await cmdScore(rest);
        break;
      case "usage":
        await cmdUsage(rest);
        break;
      case "quota":
        await cmdQuota(rest);
        break;
      case "sprint":
        await cmdSprint(rest);
        break;
      case "switch":
        await cmdSwitch(rest);
        break;
      case "analyze":
        await cmdAnalyze(rest);
        break;
      case "focus":
        await cmdFocus(rest);
        break;
      case "watch":
        await cmdWatch(rest);
        break;
      case "snooze":
        await cmdSnooze(rest);
        break;
      case "unsnooze":
        await cmdUnsnooze(rest);
        break;
      case "-h":
      case "--help":
      case "help":
        console.log(HELP);
        break;
      default:
        console.error(`stasis: error: unknown command "${cmd}"\n`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (e) {
    console.error(`stasis: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) main();
