// Capability detection — what tiers of signal are available on THIS machine, so
// onboarding can adapt (tech vs non-tech) and the dashboard can tell the user
// what it's missing. All checks are cheap and read-only; the Ollama probe has a
// short timeout so a missing server never stalls a command.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../types.ts";

export interface Capabilities {
  /** Any git repo under the projects dir → the user is (at least partly) a dev. */
  git: boolean;
  /** Any recognizable code project → used to pick tech vs non-tech language. */
  code: boolean;
  /** Claude Code usage logs present → engagement + quota signals work. */
  claudeUsage: boolean;
  /** A local Ollama server is reachable → free local AI analysis. */
  ollama: boolean;
  /** An API key is configured → hosted AI analysis (zero install). */
  apiKey: boolean;
  /** Obsidian vault with a projects folder → roi/alignment hints. */
  vault: boolean;
  /** Paperclip enabled → ground-truth %done. */
  paperclip: boolean;
}

const CODE_MARKERS = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "Gemfile",
  "composer.json",
];

function scanProjectDirs(projectsDir: string): { git: boolean; code: boolean } {
  let git = false;
  let code = false;
  if (!existsSync(projectsDir)) return { git, code };
  let entries: string[];
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "_attic")
      .map((e) => e.name);
  } catch {
    return { git, code };
  }
  for (const name of entries) {
    const dir = join(projectsDir, name);
    if (!git && existsSync(join(dir, ".git"))) git = true;
    if (!code && CODE_MARKERS.some((m) => existsSync(join(dir, m)))) code = true;
    if (git && code) break;
  }
  return { git, code };
}

async function pingOllama(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function hasClaudeUsage(claudeDir: string): boolean {
  const p = join(claudeDir, "projects");
  try {
    return existsSync(p) && readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

export async function detectCapabilities(cfg: Config): Promise<Capabilities> {
  const { git, code } = scanProjectDirs(cfg.paths.projectsDir);
  const ollama =
    cfg.analyze.provider === "ollama" ? await pingOllama(cfg.analyze.baseUrl) : false;
  return {
    git,
    code,
    claudeUsage: hasClaudeUsage(cfg.paths.claudeDir),
    ollama,
    apiKey: !!cfg.analyze.apiKey,
    vault: existsSync(join(cfg.paths.vaultDir, "1-Projects")),
    paperclip: cfg.paperclip.enabled,
  };
}

/** True when the user has any way to run AI analysis (local or hosted). */
export function hasAI(c: Capabilities): boolean {
  return c.ollama || c.apiKey;
}
