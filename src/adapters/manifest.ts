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
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface ManifestEntry {
  name: string;
  path: string;
}

/** Status-first roots: real projects live *under* these, never directly in them. */
const STATUS_DIRS = new Set(["active", "paused", "templates"]);
/** Infra dirs documented in PROJECTS.md as siblings of the status roots, never projects. */
const STRUCTURAL_DIRS = new Set(["data", "reports", "Library"]);

/**
 * Only the manifest table declares projects. Other tables in PROJECTS.md (the
 * portfolio-lane table is `| Lane | Projects |`) share the pipe syntax but have
 * different column meanings, so they are skipped by their header, not by guesswork
 * on the values.
 */
const MANIFEST_HEADERS = new Set(["project", "name"]);

/** Expands a leading `~` and passes absolute paths through untouched. */
function resolvePath(projectsDir: string, raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  if (isAbsolute(raw)) return raw;
  return join(projectsDir, raw);
}

/** Parses every `| Project | Path | ... |` row of the manifest table. Missing file → []. */
export function parseProjectsManifest(projectsDir: string): ManifestEntry[] {
  let text: string;
  try {
    text = readFileSync(join(projectsDir, "PROJECTS.md"), "utf8");
  } catch {
    return [];
  }
  const entries: ManifestEntry[] = [];
  let inManifestTable = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) {
      inManifestTable = false; // a blank or prose line closes the table
      continue;
    }
    const cols = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cols.some((c) => /^-+$/.test(c)) && cols.every((c) => c === "" || /^-+$/.test(c))) continue; // separator row
    if (!inManifestTable) {
      // A header row opens a table; only the manifest table is ours.
      const [header, second] = cols;
      if (!header || !second || !MANIFEST_HEADERS.has(header.toLowerCase())) continue;
      inManifestTable = true;
      continue;
    }
    const [name, path] = cols;
    if (!name || !path) continue;
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
    byName.set(e.name, resolvePath(projectsDir, e.path));
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
