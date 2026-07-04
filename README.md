# stasis

Anti-scatter meta-layer. Scores all your active projects on one set of variables
(ROI, urgency, proximity-to-done, momentum, effort/cost, north-star alignment),
models your Claude subscription quota, and tells you what to work on next —
so you stop hopping between 98 projects and shipping none.

Read-only aggregator + deterministic scorer. The scoring math spends **zero tokens**.

## Prerequisites

- **bun** — runtime (install: `curl -fsSL https://bun.sh/install | bash`)
- **git** — reads repos under `~/projects`
- **Claude Code** — usage logs at `~/.claude/projects` (optional, enables token tracking)
- **Ollama** — for AI analysis: `ollama serve` + `ollama pull qwen3.5:9b` (optional)

## Quick Start

```bash
bun run stasis            # dashboard: quota + scores + today's plan
stasis focus set <p> --for 2w --bet "ship it" --kill "no traction"
stasis sprint             # routed plan with your focus as anchor
stasis quota --set week=60 5h=45   # calibrate from Claude Code /usage
```

## Install

```bash
bun install          # (no deps yet — bun runs TS directly)
bun run stasis       # dashboard
```

Build a standalone binary:

```bash
bun run build        # -> ./stasis
```

## Commands

| Command | Does |
|---|---|
| `stasis` | dashboard: quota + ranked scores + today's recommendation |
| `stasis score` | ranked project scores with factor breakdown |
| `stasis usage [--project X]` | real tokens + cost from Claude Code logs |
| `stasis quota` | 5h + weekly burn; `--set` calibrates from `/usage` |
| `stasis sprint` | routed multi-project itinerary (anchor → hops → return) |
| `stasis switch [<project>]` | ROI-ranked switch menu / advisory switch |
| `stasis analyze` | AI reads each project → structured ROI/blocker/next action |
| `stasis focus` | active commitment + on-target percentage |
| `stasis focus set <p> --for 2w --bet "…" --kill "…"` | commit to a bet |
| `stasis focus review --verdict kept, killed, or pivot` | close the current bet |
| `stasis snooze <project>` | exclude from routing (still scored) |
| `stasis watch` | background monitor (detects scatter, quota, overdue) |

All commands accept `--help` for flag details. Most accept `--json` for machine parsing.

## `/stasis` skill

A Claude Code skill (`skill/SKILL.md`, symlinked to `~/.claude/skills/stasis`) wraps the
CLI: reads `stasis sprint --json`, asks 2-3 targeting questions (hours, deadline, energy),
and writes a narrative daily plan. Invoke with `/stasis`.

## Quota calibration (honest, no invented caps)

Anthropic doesn't publish Max/Pro token caps. Read your real % from Claude Code `/usage`,
then anchor your personal cap:

```bash
stasis quota --set week=60 5h=45   # derives cap = measured_tokens / (pct/100)
```

Until calibrated, quota shows raw burn only — no fake percentage.

## Config

Auto-created at `~/.stasis/config.json` on first run. Edit weights, subscription
caps, and per-project ROI/urgency overrides there.

Data sources (all read-only, all optional / graceful-skip):
- git repos under `~/projects`
- Claude Code usage logs under `~/.claude/projects`
- Obsidian Vault (optional)
- Paperclip (V1, optional)
- claude-mem (V1, optional)
