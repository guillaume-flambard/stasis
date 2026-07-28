// Filesystem adapter — the universal tier. A "project" is any folder you point
// stasis at, not just a git repo: a designer's Figma exports, a writer's drafts,
// a course folder. Git is one signal source, never the gatekeeper.
//
// Everything here is a BOUNDED walk. Scanning ~90 project trees on every command
// would be unusable, so we cap depth, skip the usual heavy directories, and stop
// after a fixed number of files — enough to know "when was this last touched and
// roughly how big is it", which is all the scorer needs.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const DAY_MS = 86_400_000;
const MAX_DEPTH = 3;
/** Stop after this many files per project — a recency/size proxy, not an audit. */
const MAX_FILES = 600;

/** Build output and dependency trees say nothing about YOUR activity. */
const IGNORE = new Set([
  "node_modules", "target", "dist", "build", "out", "coverage", "vendor",
  "__pycache__", "venv", ".venv", "Pods", "DerivedData", ".next", ".nuxt",
  ".turbo", ".cache", ".gradle", "bin", "obj",
]);

export interface FsInfo {
  /** Most recent file mtime found in the bounded walk. */
  lastModifiedAt: Date | null;
  daysSinceModified: number | null;
  /** Files seen (capped at MAX_FILES — a size proxy, not a true count). */
  fileCount: number;
  sizeBytes: number;
  /** Dominant file extensions, most common first — what kind of project this is. */
  kinds: string[];
}

const EMPTY: FsInfo = {
  lastModifiedAt: null,
  daysSinceModified: null,
  fileCount: 0,
  sizeBytes: 0,
  kinds: [],
};

/** Recency + rough size of any folder. Never throws; unreadable dirs are skipped. */
export function scanFsInfo(path: string, now: number = Date.now()): FsInfo {
  if (!existsSync(path)) return EMPTY;
  let newest = 0;
  let fileCount = 0;
  let sizeBytes = 0;
  const ext = new Map<string, number>();

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || fileCount >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied, race with a delete — just skip
    }
    for (const e of entries) {
      if (fileCount >= MAX_FILES) return;
      if (IGNORE.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".")) continue; // .git, .idea… not your work
        walk(p, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = statSync(p);
        fileCount++;
        sizeBytes += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        const x = extname(e.name).toLowerCase();
        if (x) ext.set(x, (ext.get(x) ?? 0) + 1);
      } catch {
        /* vanished between readdir and stat */
      }
    }
  };
  walk(path, 0);

  const lastModifiedAt = newest > 0 ? new Date(newest) : null;
  const kinds = [...ext.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);

  return {
    lastModifiedAt,
    daysSinceModified:
      newest > 0 ? Math.max(0, Math.floor((now - newest) / DAY_MS)) : null,
    fileCount,
    sizeBytes,
    kinds,
  };
}

/** Map of project-dir name → FsInfo for every directory under `projectsDir`. */
export function scanFs(projectsDir: string, now: number = Date.now()): Map<string, FsInfo> {
  const map = new Map<string, FsInfo>();
  if (!existsSync(projectsDir)) return map;
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const e of entries) {
    // Dirent.isDirectory() is false for symlinks-to-dirs; follow via statSync.
    if ((!e.isDirectory() && !e.isSymbolicLink()) || e.name.startsWith(".") || e.name === "_attic") continue;
    const path = join(projectsDir, e.name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    map.set(e.name, scanFsInfo(path, now));
  }
  return map;
}
