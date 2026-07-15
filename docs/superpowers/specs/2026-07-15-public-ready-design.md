# stasis — public-ready design

**Status:** approved direction (owner delegated judgment + phasing).
**Goal:** make stasis usable by anyone who downloads it — including non-technical users — not just the author's own stack. Keep it **very simple to use** (hard constraint; a user-definable-variables engine was explicitly rejected as too complex).

## Problem

stasis is currently shaped around the author:

- `src/analyze/analyze.ts` hardcodes the AI goal — "north-star is €2,500/month PASSIVE income by Dec 2026" — so the AI scores every user's projects against the author's goal.
- `alignment` has no universal source (`override` or `vault` only → collapses to 0.5 for everyone else).
- `northStarDeadline` is a fixed config value driving everyone's `urgency`.
- The Vault tag taxonomy and `~/Vault` path are the author's.
- There is no onboarding/init command.
- Scoring gates on `.filter(s => s.isGit)` — only git repos count as "projects"; any other folder is invisible (the same blind spot as off-portfolio focus and non-git Paperclip ventures).

A bare public user therefore gets a weak git-only ranking with flat roi/alignment, aimed at the author's deadline. A non-technical user (a folder of documents, no git) gets nothing.

## Principles

1. **A project = any folder the user points at**, not a git repo. Git is one signal source, not the gatekeeper.
2. **Tiered, graceful degradation.** Works minimally with just a folder; better with git; better with AI; best with connectors.
3. **The user's own goal drives the model** — one plain-language statement, not a config schema.
4. **Very simple.** Auto-guided onboarding, sensible defaults, the tool explains what it's missing.

## Tiers

- **Tier 0 — Filesystem (universal, non-tech):** for any dir — most-recent file mtime → `momentum`; size / file count → `effort`; dominant file types → context. Even with no git and no AI, the user gets a *map* (folders newest→oldest, size, type) = "find your way around."
- **Tier 1 — +git:** richer `proximity`/`momentum`/dirty when `.git` exists (dev bonus).
- **Tier 2 — +AI (`analyze`):** reads the folder (code OR docs) and scores `roi`/`%done`/`alignment` against the user's stated goal. For non-tech this is the real unlock; onboarding pushes the hosted-API-key path (zero install, unlike Ollama).
- **Tier 3 — +connectors:** vault / paperclip / claude-mem — bonus, already built.

## Components

### Goal profile
Config gains `goal: { statement: string; deadline: string | null }`, replacing `northStarDeadline`.
- `goal.statement` → interpolated into the analyze prompts (per-project + portfolio).
- `goal.deadline` → `urgencyFactor` (null → neutral urgency).
- Migration: existing config with `northStarDeadline` and no `goal` → `goal.deadline` inherits it, `goal.statement` = a generic default. The author's own config keeps his goal.

### Alignment source
`analyze` output gains `alignment: 0..10` (fit to the user's goal). `alignmentFactor` precedence becomes `override > analysis.alignment > vault > 0.5`. Without AI, alignment stays neutral — acceptable in the lower tiers.

### Onboarding (`stasis init` + auto first-run)
`cmdInit()` — a short terminal wizard (readline; non-TTY → defaults + written config + hint):
1. Where are your projects? (default `~/projects`)
2. Your goal in one sentence + optional deadline.
3. Detect capabilities: Claude Code logs, Ollama (`localhost:11434`), an API key, Vault, Paperclip CLI.
4. If a model is available → offer to run the first `analyze`.
5. Write config, show the ranking.

`stasis` with no config file → runs `cmdInit` automatically, then the dashboard. Language adapts tech vs non-tech (are there `.git` dirs / code?).

### Capability detection + self-guidance
New `adapters/detect.ts` (pure-ish): ping Ollama, check for Claude logs, API key, vault dir, paperclip CLI → a `Capabilities` readout. Shown at the end of `init`, and as a one-line dashboard hint when signals are thin ("roi/alignment are neutral — enable a model with `stasis analyze` for real judgments").

## Phasing

**Phase 1 (near-term, low risk to the author's daily tool — does NOT change the scored project set):**
- Goal profile (config + migration + analyze prompt + urgency).
- `analyze` outputs `alignment`; `alignmentFactor` precedence updated; `store.ts` persists it.
- `stasis init` wizard + auto first-run.
- `adapters/detect.ts` + capability hints.

**Phase 2 (longer-term, per the owner's "maybe long-term"):**
- Filesystem Tier-0 (`adapters/fs.ts`) + drop the `isGit` gate. Requires generalizing the active-window filter from `daysSinceCommit` → `daysSinceModified` so stale junk folders don't flood the ranking. Subsumes the spawned "surface non-git ventures" task.
- Non-code document analysis in the collector.
- Tech-vs-non-tech onboarding polish, hosted-API-key nudge.

## Testing
- `detect.ts`: capability detection (mocked filesystem / ports).
- config migration: `northStarDeadline` → `goal.deadline`; default goal seeded.
- `alignmentFactor` precedence: analysis.alignment overrides vault, under override.
- `urgencyFactor` reads `goal.deadline`.
- Phase 2: fs signals (mtime/size on a temp dir), isGit-gate removal keeps active filtering sane.

## Non-goals
- User-definable scoring factors/weights (rejected: too complex).
- A GUI (CLI + optional `/stasis` skill only; Tamagui dashboard stays a separate V2).
