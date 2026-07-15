// Read-only Paperclip adapter. Paperclip is Guillaume's self-hosted issue tracker
// (`paperclipai` CLI + server at 127.0.0.1:3100). Companies map to ventures; each
// issue has a status. done/total across a company's live issues is a GROUND-TRUTH
// completion signal — human-tracked, so it outranks the AI's %done guess for
// proximity. Everything shells out through the CLI (which handles local auth) and
// graceful-skips: server down, CLI missing, or disabled → empty map, no error.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STASIS_DIR } from "../config.ts";

// Fetching issues shells out N times (one per company), ~0.9s total. That's too
// much to pay on every `stasis` invocation, so results are cached briefly; issue
// state doesn't change second-to-second. Delete the cache file to force a refresh.
const CACHE_PATH = join(STASIS_DIR, "paperclip-cache.json");
const CACHE_TTL_MS = 5 * 60_000;

export interface PaperclipInfo {
  percentDone: number; // 0..1, done / non-cancelled total
  done: number;
  total: number;
  open: number;
}

interface Cache {
  fetchedAt: number;
  repoKey: string; // guards against a stale cache after the repo set changes
  entries: Record<string, PaperclipInfo>;
}

export interface Company {
  id: string;
  name: string;
  status: string;
  issuePrefix?: string;
}

export interface Issue {
  status: string;
  hiddenAt?: string | null;
}

/** Normalize a name for fuzzy dir matching: lowercase, strip non-alphanumerics. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve which ~/projects dir each active company belongs to. Priority:
 * explicit companyMap (by name or issue-prefix) > normalized-name match against
 * the repo list. Companies that resolve to nothing are dropped (can't attribute).
 * Pure — no I/O — so it's unit-testable.
 */
export function resolveTargets(
  companies: Company[],
  repoNames: string[],
  companyMap: Record<string, string>,
): Array<{ id: string; dir: string }> {
  const byNorm = new Map(repoNames.map((n) => [norm(n), n]));
  const out: Array<{ id: string; dir: string }> = [];
  for (const c of companies) {
    if (c.status !== "active") continue;
    const mapped =
      companyMap[c.name] ?? (c.issuePrefix ? companyMap[c.issuePrefix] : undefined);
    const dir = mapped ?? byNorm.get(norm(c.name));
    if (dir) out.push({ id: c.id, dir });
  }
  return out;
}

/**
 * Completion from a company's issues: done / (total minus cancelled + hidden).
 * Cancelled/hidden issues aren't real remaining work, so they leave the denominator.
 * Returns null when there's nothing countable. Pure — unit-testable.
 */
export function computeInfo(issues: Issue[]): PaperclipInfo | null {
  const live = issues.filter((i) => i && i.status !== "cancelled" && !i.hiddenAt);
  const total = live.length;
  if (total === 0) return null;
  const done = live.filter((i) => i.status === "done").length;
  return { percentDone: done / total, done, total, open: total - done };
}

/** Run a `paperclipai` subcommand, returning stdout or null on any failure. */
async function cli(args: string[], timeoutMs = 4000): Promise<string | null> {
  try {
    const proc = Bun.spawn(["paperclipai", ...args], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 ? out : null;
  } catch {
    return null; // CLI not installed, spawn blocked, etc.
  }
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/**
 * Map of lowercased project-dir name → PaperclipInfo. Empty if Paperclip is
 * disabled, its CLI/server is unreachable, or nothing maps to a known repo.
 * Issue lists are fetched in parallel to keep total latency ~one round-trip.
 */
export async function loadPaperclip(
  repoNames: string[],
  cfg: { enabled: boolean; companyMap: Record<string, string> },
  now: number = Date.now(),
): Promise<Map<string, PaperclipInfo>> {
  const map = new Map<string, PaperclipInfo>();
  if (!cfg.enabled) return map;

  const repoKey = String(repoNames.length);
  const cached = readCache();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS && cached.repoKey === repoKey) {
    for (const [k, v] of Object.entries(cached.entries)) map.set(k, v);
    return map;
  }

  const companies = parseJson<Company[]>(await cli(["company", "list", "--json"]));
  if (!companies || !Array.isArray(companies)) return map; // server down → skip (no cache write)

  const targets = resolveTargets(companies, repoNames, cfg.companyMap ?? {});
  const results = await Promise.all(
    targets.map(async (t) => {
      const issues = parseJson<Issue[]>(await cli(["issue", "list", "-C", t.id, "--json"]));
      if (!issues || !Array.isArray(issues)) return null;
      const info = computeInfo(issues);
      return info ? { dir: t.dir, info } : null;
    }),
  );
  for (const r of results) if (r) map.set(r.dir.toLowerCase(), r.info);
  writeCache({ fetchedAt: now, repoKey, entries: Object.fromEntries(map) });
  return map;
}

function readCache(): Cache | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache;
  } catch {
    return null;
  }
}

function writeCache(c: Cache): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(c));
  } catch {
    /* cache is best-effort */
  }
}
