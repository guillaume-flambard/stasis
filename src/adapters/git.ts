// Read-only git scanner. Enumerates repos under projectsDir and collects
// activity signals. Never mutates anything.
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export interface GitInfo {
  name: string;
  path: string;
  isGit: boolean;
  lastCommitAt: Date | null;
  daysSinceCommit: number | null;
  dirtyCount: number;
  aheadCount: number;
  branch: string | null;
}

const DAY_MS = 86_400_000;

/** Run a git command in a repo; return trimmed stdout or null on any failure. */
function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function collect(name: string, path: string, now: number): GitInfo {
  const isGit = existsSync(join(path, ".git"));
  if (!isGit) {
    return {
      name,
      path,
      isGit: false,
      lastCommitAt: null,
      daysSinceCommit: null,
      dirtyCount: 0,
      aheadCount: 0,
      branch: null,
    };
  }

  const iso = git(path, ["log", "-1", "--format=%cI"]);
  const lastCommitAt = iso ? new Date(iso) : null;
  const daysSinceCommit = lastCommitAt
    ? Math.floor((now - lastCommitAt.getTime()) / DAY_MS)
    : null;

  const status = git(path, ["status", "--porcelain"]);
  const dirtyCount = status ? status.split("\n").filter(Boolean).length : 0;

  const branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);

  // Commits ahead of upstream (unpushed work → close to a shippable checkpoint).
  let aheadCount = 0;
  const ahead = git(path, ["rev-list", "--count", "@{upstream}..HEAD"]);
  if (ahead) aheadCount = Number(ahead) || 0;

  return { name, path, isGit: true, lastCommitAt, daysSinceCommit, dirtyCount, aheadCount, branch };
}

/** Scan projectsDir one level deep. Skips dotfiles and the _attic archive. */
export function scanRepos(projectsDir: string): GitInfo[] {
  if (!existsSync(projectsDir)) return [];
  const now = Date.now();
  const out: GitInfo[] = [];
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "_attic") continue;
    const path = join(projectsDir, entry.name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(collect(entry.name, path, now));
  }
  return out;
}
