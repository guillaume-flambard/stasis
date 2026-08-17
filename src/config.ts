// Loads (and first-run seeds) ~/.stasis/config.json.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Config, ShadowConfig } from "./types.ts";
export type { Config };

const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
  checkInterval: 300,
  notifyUrgent: true,
  hotProjectThreshold: 15_000,
};

export const STASIS_DIR = join(homedir(), ".stasis");
export const CONFIG_PATH = join(STASIS_DIR, "config.json");

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

export const DEFAULT_CONFIG: Config = {
  paths: {
    projectsDir: join(homedir(), "projects"),
    vaultDir: join(homedir(), "Vault"),
    claudeDir: join(homedir(), ".claude"),
    claudeMemDb: join(homedir(), ".claude-mem", "claude-mem.db"),
  },
  goal: {
    statement: "Ship work that creates value and finish what you start",
    deadline: null,
  },
  activeWindowDays: 30,
  focusExcludeCwd: [],
  analyze: {
    provider: "ollama",
    model: "qwen3.5:9b", // strong local reasoner for deep + global passes
    fastModel: "llama3.2:3b",
    baseUrl: "http://localhost:11434",
    apiKey: null,
    maxRounds: 2,
    numCtx: 8192,
    temperature: 0.2,
  },
  shadow: DEFAULT_SHADOW_CONFIG,
  subscriptions: [
    {
      name: "claude_max_5x",
      // No invented caps. Calibrate from real /usage: `stasis quota --set week=.. 5h=..`
      weeklyTokenCap: null,
      rolling5hTokenCap: null,
      resetDay: "Monday",
    },
  ],
  weights: {
    roi: 0.2,
    engagement: 0.22,
    proximity: 0.15,
    momentum: 0.15,
    urgency: 0.1,
    effort: 0.1,
    alignment: 0.08,
  },
  overrides: {},
  paperclip: { enabled: false, companyMap: {} },
};

/**
 * Resolve the goal profile, migrating the legacy `northStarDeadline` field:
 * an old config with a deadline but no `goal` inherits that deadline.
 */
function mergeGoal(base: Config, user: Partial<Config>): Config["goal"] {
  if (user.goal) return { ...base.goal, ...user.goal };
  const legacy = (user as { northStarDeadline?: string }).northStarDeadline;
  if (legacy) return { statement: base.goal.statement, deadline: legacy };
  return base.goal;
}

/** Deep-ish merge: user config wins, defaults fill gaps (one level for nested objects).
 *  Exported for migration tests. */
export function mergeConfig(base: Config, user: Partial<Config>): Config {
  return {
    paths: { ...base.paths, ...(user.paths ?? {}) },
    analyze: { ...base.analyze, ...(user.analyze ?? {}) },
    shadow: { ...base.shadow, ...(user.shadow ?? {}) },
    goal: mergeGoal(base, user),
    activeWindowDays: user.activeWindowDays ?? base.activeWindowDays,
    focusExcludeCwd: user.focusExcludeCwd ?? base.focusExcludeCwd,
    subscriptions: user.subscriptions ?? base.subscriptions,
    weights: { ...base.weights, ...(user.weights ?? {}) },
    overrides: user.overrides ?? base.overrides,
    paperclip: { ...base.paperclip, ...(user.paperclip ?? {}) },
  };
}

/** Write merged config back to disk (preserves user formatting via JSON.stringify). */
export function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

/** Load config, seeding a default file on first run. Paths are home-expanded. */
export function loadConfig(): Config {
  let cfg = DEFAULT_CONFIG;
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(STASIS_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  } else {
    try {
      const user = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
      cfg = mergeConfig(DEFAULT_CONFIG, user);
    } catch (e) {
      console.error(
        `stasis: error: config at ${CONFIG_PATH} is corrupted. Fix the JSON or delete it to regenerate defaults.\n  ${(e as Error).message}`,
      );
      process.exit(1);
    }
  }
  return {
    ...cfg,
    paths: {
      projectsDir: expandHome(cfg.paths.projectsDir),
      vaultDir: expandHome(cfg.paths.vaultDir),
      claudeDir: expandHome(cfg.paths.claudeDir),
      claudeMemDb: expandHome(cfg.paths.claudeMemDb),
    },
  };
}
