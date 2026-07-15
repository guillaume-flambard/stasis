import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { loadClaudeMem } from "./claudemem.ts";

const DAY_MS = 86_400_000;
const NOW = 1_784_000_000_000; // fixed "now" for deterministic recency math

let dbPath: string | null = null;

/** Build a throwaway claude-mem-shaped DB with the given observation rows. */
function makeDb(rows: Array<{ project: string; ageDays: number }>): string {
  const p = join(tmpdir(), `stasis-mem-${NOW}-${Math.round(Math.random() * 1e9)}.db`);
  const db = new Database(p);
  db.run(
    `CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, created_at_epoch INTEGER)`,
  );
  const ins = db.prepare(`INSERT INTO observations (project, created_at_epoch) VALUES (?, ?)`);
  for (const r of rows) ins.run(r.project, NOW - r.ageDays * DAY_MS);
  db.close();
  dbPath = p;
  return p;
}

afterEach(() => {
  if (dbPath && existsSync(dbPath)) rmSync(dbPath);
  dbPath = null;
});

describe("loadClaudeMem", () => {
  test("returns empty map when DB file is absent", () => {
    const m = loadClaudeMem("/no/such/claude-mem.db", 21, NOW);
    expect(m.size).toBe(0);
  });

  test("counts recent observations and computes recency per project", () => {
    const p = makeDb([
      { project: "weave", ageDays: 0 },
      { project: "weave", ageDays: 2 },
      { project: "stasis", ageDays: 5 },
    ]);
    const m = loadClaudeMem(p, 21, NOW);
    expect(m.get("weave")).toEqual({ obsRecent: 2, daysSinceObs: 0 });
    expect(m.get("stasis")).toEqual({ obsRecent: 1, daysSinceObs: 5 });
  });

  test("excludes observations older than the window", () => {
    const p = makeDb([
      { project: "old", ageDays: 40 },
      { project: "fresh", ageDays: 3 },
    ]);
    const m = loadClaudeMem(p, 21, NOW);
    expect(m.has("old")).toBe(false);
    expect(m.get("fresh")?.obsRecent).toBe(1);
  });

  test("lowercases project names and drops the unknown-project bucket", () => {
    const p = makeDb([
      { project: "Weave", ageDays: 1 },
      { project: "unknown-project", ageDays: 1 },
    ]);
    const m = loadClaudeMem(p, 21, NOW);
    expect(m.has("weave")).toBe(true);
    expect(m.has("unknown-project")).toBe(false);
  });
});
