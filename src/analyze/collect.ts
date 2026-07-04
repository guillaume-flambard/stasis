// Gathers the real, unstructured state of a project into a compact evidence
// string the model can judge. Read-only. Budgeted to fit small local models.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const MAX_README = 2500;
const MAX_TREE_ENTRIES = 40;

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

function readIfExists(path: string, max: number): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8").slice(0, max);
  } catch {
    return "";
  }
}

function firstReadme(dir: string): string {
  for (const n of ["README.md", "readme.md", "README.MD", "README"]) {
    const p = join(dir, n);
    if (existsSync(p)) return readIfExists(p, MAX_README);
  }
  return "";
}

function shallowTree(dir: string): string {
  const out: string[] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === ".next" || e.name === "dist" || e.name === "build" || e.name === "vendor" || e.name === "__pycache__" || e.name === ".venv") continue;
      out.push(e.isDirectory() ? e.name + "/" : e.name);
      if (out.length >= MAX_TREE_ENTRIES) break;
    }
  } catch {
    /* ignore */
  }
  return out.join(", ");
}

function pkgSummary(dir: string): string {
  const raw = readIfExists(join(dir, "package.json"), 4000);
  if (!raw) return "";
  try {
    const p = JSON.parse(raw);
    const scripts = p.scripts ? Object.keys(p.scripts).join(", ") : "";
    const deps = p.dependencies ? Object.keys(p.dependencies).slice(0, 20).join(", ") : "";
    return `package.json: name=${p.name ?? "?"} scripts=[${scripts}] deps=[${deps}]`;
  } catch {
    return "";
  }
}

export interface Evidence {
  name: string;
  text: string;
  hasReadme: boolean;
}

/** Build the evidence bundle for one project dir. `vaultNote` is optional body text. */
export function collectEvidence(name: string, dir: string, vaultNote?: string): Evidence {
  const readme = firstReadme(dir);
  const log = git(dir, ["log", "-15", "--pretty=%cd %s", "--date=short"]);
  const lastStat = git(dir, ["log", "-1", "--stat", "--pretty=%cd", "--date=short"]).slice(0, 600);
  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = git(dir, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
  const tree = shallowTree(dir);
  const pkg = pkgSummary(dir);

  const parts = [
    `PROJECT: ${name}   branch: ${branch || "?"}   uncommitted files: ${dirty}`,
    tree && `FILES: ${tree}`,
    pkg,
    readme && `README (truncated):\n${readme}`,
    vaultNote && `VAULT NOTE (truncated):\n${vaultNote.slice(0, 1200)}`,
    log && `RECENT COMMITS:\n${log}`,
    lastStat && `LAST COMMIT CHANGES:\n${lastStat}`,
  ].filter(Boolean);

  return { name, text: parts.join("\n\n"), hasReadme: !!readme };
}

/** True if a path is a directory we can read. */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
