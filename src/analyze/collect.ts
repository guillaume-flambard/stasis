// Gathers the real, unstructured state of a project into a compact evidence
// string the model can judge. Read-only. Budgeted to fit small local models.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const MAX_README = 2500;
const MAX_TREE_ENTRIES = 40;
/** Text documents are the "README" of a non-code project — read a couple. */
const MAX_DOC = 900;
const MAX_DOCS = 3;
const DOC_EXT = new Set([".md", ".markdown", ".txt", ".rst", ".org"]);

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

/**
 * Excerpts from plain-text documents other than the README. For a folder of
 * writing, notes or specs these ARE the project — without them a non-code
 * project reaches the model as nothing but a list of filenames.
 */
function docExcerpts(dir: string): string {
  const out: string[] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_DOCS) break;
      if (!e.isFile() || e.name.startsWith(".")) continue;
      if (/^readme/i.test(e.name)) continue; // already captured
      const dot = e.name.lastIndexOf(".");
      if (dot < 0 || !DOC_EXT.has(e.name.slice(dot).toLowerCase())) continue;
      const body = readIfExists(join(dir, e.name), MAX_DOC).trim();
      if (body) out.push(`--- ${e.name}\n${body}`);
    }
  } catch {
    /* ignore */
  }
  return out.join("\n");
}

/** Names carry meaning when there's no code: "Devis client.pdf" says a lot. */
function fileNames(dir: string): { list: string; count: number } {
  const names: string[] = [];
  let count = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      count++;
      if (names.length < MAX_TREE_ENTRIES) names.push(e.isDirectory() ? e.name + "/" : e.name);
    }
  } catch {
    /* ignore */
  }
  return { list: names.join(", "), count };
}

export interface Evidence {
  name: string;
  text: string;
  hasReadme: boolean;
}

export interface CollectOpts {
  vaultNote?: string;
  /** Git repo? When false we omit branch/commit framing entirely — reporting
   *  "branch: ? uncommitted: 0" for a folder of PDFs is misleading, not neutral. */
  isGit?: boolean;
  /** Dominant file extensions, from the filesystem adapter. */
  kinds?: string[];
  daysSinceModified?: number | null;
}

/**
 * Build the evidence bundle for one project dir. A project is any folder, so
 * there are two shapes: a git repo (commits, branch, dirty tree) and everything
 * else (documents, file names, recency). Sending git framing for a folder that
 * has no git would tell the model a project is pristine and idle when it's
 * neither.
 */
export function collectEvidence(name: string, dir: string, opts: CollectOpts = {}): Evidence {
  // A folder can vanish between a scan and an analysis (moved, deleted, an
  // unmounted volume). Say so instead of emitting a confident header for
  // nothing — a model handed "PROJECT: x" and no evidence will invent some.
  if (!existsSync(dir)) {
    return {
      name,
      text: `PROJECT: ${name}\n\nThis folder no longer exists at ${dir}. It was moved, deleted, or lives on a volume that isn't mounted. There is no evidence to judge.`,
      hasReadme: false,
    };
  }
  const readme = firstReadme(dir);
  const isGit = opts.isGit ?? existsSync(join(dir, ".git"));
  const parts: (string | false | undefined)[] = [];

  if (isGit) {
    const log = git(dir, ["log", "-15", "--pretty=%cd %s", "--date=short"]);
    const lastStat = git(dir, ["log", "-1", "--stat", "--pretty=%cd", "--date=short"]).slice(0, 600);
    const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const dirty = git(dir, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
    parts.push(
      `PROJECT: ${name}   branch: ${branch || "?"}   uncommitted files: ${dirty}`,
      shallowTree(dir) && `FILES: ${shallowTree(dir)}`,
      pkgSummary(dir),
      readme && `README (truncated):\n${readme}`,
      opts.vaultNote && `VAULT NOTE (truncated):\n${opts.vaultNote.slice(0, 1200)}`,
      log && `RECENT COMMITS:\n${log}`,
      lastStat && `LAST COMMIT CHANGES:\n${lastStat}`,
    );
  } else {
    // Not a code repo: the file names, the documents and the recency are all we
    // have — and for a writer or a designer they're the whole project.
    const { list, count } = fileNames(dir);
    const touched =
      opts.daysSinceModified == null
        ? ""
        : opts.daysSinceModified === 0
          ? "today"
          : `${opts.daysSinceModified} days ago`;
    parts.push(
      `PROJECT: ${name}   (not a code repository — judge it as a folder of work)`,
      count > 0 && `${count} items${touched && `, last touched ${touched}`}`,
      opts.kinds && opts.kinds.length > 0 ? `MAIN FILE TYPES: ${opts.kinds.join(", ")}` : false,
      list && `FILES: ${list}`,
      readme && `README (truncated):\n${readme}`,
      docExcerpts(dir) && `DOCUMENTS (excerpts):\n${docExcerpts(dir)}`,
      opts.vaultNote && `NOTE (truncated):\n${opts.vaultNote.slice(0, 1200)}`,
    );
  }

  return { name, text: parts.filter(Boolean).join("\n\n"), hasReadme: !!readme };
}

/** True if a path is a directory we can read. */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
