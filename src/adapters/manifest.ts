// Reads ~/projects/PROJECTS.md — the user's own "one row per project" manifest —
// as the authoritative map of project name → relative path. Needed because the
// 2026-08-13 status-first reorg (active/paused/templates, then domain folders,
// then arbitrarily deep containers) means "one level under projectsDir" no longer
// finds real projects, and no fixed depth or git-boundary heuristic can recover
// it: some containers (n8n-world) hold separately-tracked child repos, others
// (bounty-toolkit) hold vendored clones that must NOT be tracked. Only the
// manifest — which the user already curates for exactly this purpose — knows
// the difference.
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

export interface ManifestEntry {
  name: string;
  path: string;
}

/** Status-first roots: real projects live *under* these, never directly in them. */
const STATUS_DIRS = new Set(["active", "paused", "templates"]);
/** Infra dirs documented in PROJECTS.md as siblings of the status roots, never projects. */
const STRUCTURAL_DIRS = new Set(["data", "reports"]);

/** Parses every `| Project | Path | ... |` row from PROJECTS.md. Missing file → []. */
export function parseProjectsManifest(projectsDir: string): ManifestEntry[] {
  let text: string;
  try {
    text = readFileSync(join(projectsDir, "PROJECTS.md"), "utf8");
  } catch {
    return [];
  }
  const entries: ManifestEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cols = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cols.length < 2) continue;
    const [name, path] = cols;
    if (!name || !path) continue;
    if (name === "Project" || /^-+$/.test(name)) continue; // header / separator row
    entries.push({ name, path });
  }
  return entries;
}

/**
 * The real project list: manifest rows (resolved to absolute paths, covering
 * everything nested under active/paused/templates) plus any top-level dir under
 * projectsDir that isn't a status root, a structural dir, or already manifest-listed
 * — e.g. an ad-hoc symlinked project, or a flat legacy layout with no manifest at all.
 */
export function resolveProjectDirs(projectsDir: string): ManifestEntry[] {
  const byName = new Map<string, string>();

  for (const e of parseProjectsManifest(projectsDir)) {
    byName.set(e.name, join(projectsDir, e.path));
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    // Dirent.isDirectory() is false for symlinks-to-dirs; follow via statSync.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".") || entry.name === "_attic") continue;
    if (STATUS_DIRS.has(entry.name) || STRUCTURAL_DIRS.has(entry.name)) continue;
    if (byName.has(entry.name)) continue;
    const path = join(projectsDir, entry.name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    byName.set(entry.name, path);
  }

  return [...byName.entries()].map(([name, path]) => ({ name, path }));
}
