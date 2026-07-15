// Read-only claude-mem adapter. claude-mem logs an `observations` row every time
// a session records a decision/discovery/fix for a project. Those rows are a
// momentum signal git can't see: you can pour a day of thinking into a project
// (logged as observations) without a single commit. We read the local SQLite DB
// directly (via bun's built-in driver, zero deps) and, per project, count recent
// observations and how long since the last one. Graceful-skips if the DB is
// absent or unreadable — claude-mem is optional.
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

const DAY_MS = 86_400_000;

export interface MemInfo {
  /** Observations logged for this project within the window — a velocity proxy. */
  obsRecent: number;
  /** Days since the most recent observation, or null if none in the window. */
  daysSinceObs: number | null;
}

interface Row {
  project: string;
  c: number;
  last: number; // epoch ms of most recent observation
}

/**
 * Map of lowercased project name → MemInfo, for projects with observations in the
 * last `windowDays`. Empty map if claude-mem isn't installed or the DB won't open.
 * `now` is injectable for tests.
 */
export function loadClaudeMem(
  dbPath: string,
  windowDays: number,
  now: number = Date.now(),
): Map<string, MemInfo> {
  const map = new Map<string, MemInfo>();
  if (!existsSync(dbPath)) return map;

  let db: Database | null = null;
  try {
    // Read-only so we never touch the user's memory DB; WAL mode is fine to read.
    db = new Database(dbPath, { readonly: true });
    const cutoff = now - windowDays * DAY_MS;
    const rows = db
      .query<Row, [number]>(
        `SELECT project AS project, COUNT(*) AS c, MAX(created_at_epoch) AS last
         FROM observations
         WHERE created_at_epoch > ?
         GROUP BY project`,
      )
      .all(cutoff);
    for (const r of rows) {
      if (!r.project) continue;
      const name = r.project.toLowerCase();
      // Skip claude-mem's own sentinel buckets — they aren't real project dirs.
      if (name === "unknown-project") continue;
      map.set(name, {
        obsRecent: r.c,
        daysSinceObs: r.last ? Math.max(0, Math.floor((now - r.last) / DAY_MS)) : null,
      });
    }
  } catch {
    // Locked, corrupt, or schema drift → degrade to no signal, never crash.
    return map;
  } finally {
    db?.close();
  }
  return map;
}
