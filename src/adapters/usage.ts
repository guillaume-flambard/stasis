// Read-only parser for Claude Code session logs under ~/.claude/projects/**/*.jsonl.
// Attributes tokens + cost per project (by cwd) and emits a recent-event stream
// for quota windowing. Per-file results are cached by (mtime,size) in
// ~/.stasis/usage-cache.json so only changed/new files are reparsed.
import { readdirSync, existsSync, statSync, createReadStream, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import { costOf, type TokenBreakdown } from "../core/pricing.ts";
import { STASIS_DIR } from "../config.ts";

export interface ProjectUsage {
  cwd: string;
  name: string; // basename(cwd)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  lastActivity: Date | null;
  /** Output tokens within the engagement window (recent investment). */
  recentOutputTokens: number;
}

export interface UsageEvent {
  ts: number;
  model: string;
  cwd: string; // project working dir — enables per-project attribution
  outputTokens: number;
  totalTokens: number; // input+output+cacheWrite+cacheRead (weight vs a window)
  costUsd: number;
}

export interface UsageIndex {
  byCwd: Map<string, ProjectUsage>;
  recentEvents: UsageEvent[]; // within lookback, ascending
}

const DAY_MS = 86_400_000;
const CACHE_PATH = join(STASIS_DIR, "usage-cache.json");
const CACHE_VERSION = 3; // v3: cache_creation split (1h @ 2×), synthetic=$0, fast mode

// Per-file cached result. Totals are kept forever (all-time accounting);
// events are kept only for files recent enough to fall in a quota window.
interface FileEntry {
  mtimeMs: number;
  size: number;
  cwd: string;
  in: number;
  out: number;
  cr: number;
  cw: number;
  cost: number;
  lastTs: number; // newest record ts, 0 if none
  events: Array<[number, string, number, number, number]>; // [ts,model,out,total,cost]
}
interface Cache {
  version: number;
  files: Record<string, FileEntry>;
}

function loadCache(): Cache {
  try {
    const c = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache;
    if (c.version === CACHE_VERSION && c.files) return c;
  } catch {
    /* no/invalid cache */
  }
  return { version: CACHE_VERSION, files: {} };
}

function listJsonl(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const proj of readdirSync(dir, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pdir = join(dir, proj.name);
    for (const f of readdirSync(pdir, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith(".jsonl")) out.push(join(pdir, f.name));
    }
  }
  return out;
}

// Parse one file into a FileEntry. `keepEventsSince` = only retain events at or
// after this ts (older files store [] to bound cache size).
async function parseFile(
  file: string,
  mtimeMs: number,
  size: number,
  keepEventsSince: number,
): Promise<FileEntry> {
  const e: FileEntry = {
    mtimeMs,
    size,
    cwd: "unknown",
    in: 0,
    out: 0,
    cr: 0,
    cw: 0,
    cost: 0,
    lastTs: 0,
    events: [],
  };
  // Claude Code re-logs the same assistant message many times within a file
    // (streaming/continuation). Count each message.id once — else tokens inflate
    // ~2.4x. Dupes are within-file only (verified), so a per-file set suffices.
  const seenIds = new Set<string>();
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const u = o?.message?.usage;
    if (o?.type !== "assistant" || !u) continue;

    const id: string | undefined = o.message.id;
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }

    const model: string = o.message.model ?? "unknown";
    if (o.cwd) e.cwd = o.cwd;
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;

    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    // cache_creation may be a flat number (legacy) or a split object (current).
    const cc = u.cache_creation;
    let cacheWrite5m = 0;
    let cacheWrite1h = 0;
    if (cc && typeof cc === "object") {
      cacheWrite5m = cc.ephemeral_5m_input_tokens ?? 0;
      cacheWrite1h = cc.ephemeral_1h_input_tokens ?? 0;
    } else {
      // legacy: treat all as 5m ephemeral (1.25×)
      cacheWrite5m = u.cache_creation_input_tokens ?? 0;
    }
    const cacheWriteTotal = cacheWrite5m + cacheWrite1h;
    const isFast = u.speed === "fast";
    const t: TokenBreakdown = { input, output, cacheWrite5m, cacheWrite1h, cacheRead, isFast };
    const cost = costOf(model, t);

    e.in += input;
    e.out += output;
    e.cr += cacheRead;
    e.cw += cacheWriteTotal;
    e.cost += cost;
    if (!Number.isNaN(ts)) {
      if (ts > e.lastTs) e.lastTs = ts;
      if (ts >= keepEventsSince) {
        e.events.push([ts, model, output, input + output + cacheWriteTotal + cacheRead, cost]);
      }
    }
  }
  return e;
}

/**
 * Build the usage index.
 * `lookbackDays` bounds the recent-event stream (quota windows).
 * `engagementDays` bounds the per-project recent-investment sum (scoring).
 */
export async function parseUsage(
  claudeDir: string,
  lookbackDays = 8,
  engagementDays = 21,
): Promise<UsageIndex> {
  const now = Date.now();
  const engagementSince = now - engagementDays * DAY_MS;
  // Retain events long enough to cover both windows (+margin) from cache.
  const keepEventsSince = now - (Math.max(lookbackDays, engagementDays) + 2) * DAY_MS;

  const cache = loadCache();
  const nextFiles: Record<string, FileEntry> = {};
  let dirty = false;

  const byCwd = new Map<string, ProjectUsage>();
  const recentEvents: UsageEvent[] = [];

  for (const file of listJsonl(join(claudeDir, "projects"))) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    const cached = cache.files[file];
    let entry: FileEntry;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      entry = cached;
    } else {
      try {
        entry = await parseFile(file, st.mtimeMs, st.size, keepEventsSince);
        dirty = true;
      } catch {
        continue; // unreadable file → skip, keep going
      }
    }
    nextFiles[file] = entry;

    // fold totals
    let pu = byCwd.get(entry.cwd);
    if (!pu) {
      pu = {
        cwd: entry.cwd,
        name: basename(entry.cwd),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        lastActivity: null,
        recentOutputTokens: 0,
      };
      byCwd.set(entry.cwd, pu);
    }
    pu.inputTokens += entry.in;
    pu.outputTokens += entry.out;
    pu.cacheReadTokens += entry.cr;
    pu.cacheWriteTokens += entry.cw;
    pu.costUsd += entry.cost;
    if (entry.lastTs > 0) {
      const d = new Date(entry.lastTs);
      if (!pu.lastActivity || d > pu.lastActivity) pu.lastActivity = d;
    }

    // fold events over the engagement window. Quota (5h/week) filters this
    // stream itself; fidelity needs the wider window (commitment horizons).
    for (const [ts, model, out, total, cost] of entry.events) {
      if (ts < engagementSince) continue;
      pu.recentOutputTokens += out;
      recentEvents.push({
        ts,
        model,
        cwd: entry.cwd,
        outputTokens: out,
        totalTokens: total,
        costUsd: cost,
      });
    }
  }

  // prune removed files; rewrite cache if anything changed
  if (dirty || Object.keys(nextFiles).length !== Object.keys(cache.files).length) {
    try {
      writeFileSync(CACHE_PATH, JSON.stringify({ version: CACHE_VERSION, files: nextFiles }));
    } catch {
      /* cache is best-effort */
    }
  }

  recentEvents.sort((a, b) => a.ts - b.ts);
  return { byCwd, recentEvents };
}
