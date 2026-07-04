# stasis

Anti-scatter meta-layer. Scores all your active projects on one set of variables
(ROI, urgency, proximity-to-done, momentum, effort/cost, north-star alignment),
models your Claude subscription quota, and tells you what to work on next —
so you stop hopping between 98 projects and shipping none.

Read-only aggregator + deterministic scorer. The scoring math spends **zero tokens**.

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
| `stasis score [--json]` | ranked project scores with factor breakdown |
| `stasis usage [--project X]` | real tokens + cost from Claude Code logs (deduped by message.id) |
| `stasis quota` | 5h + weekly burn; `--set week=<pct> 5h=<pct>` calibrates from `/usage` |
| `stasis sprint` | today's single-focus plan: WHY/WHEN/HOW + budget + ROI switch menu |
| `stasis switch [<project>]` | no arg = ROI-ranked menu; named = advisory switch + log |

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
git repos under `~/projects`, Claude Code usage logs under `~/.claude/projects`,
and (V1) Obsidian Vault, Paperclip, claude-mem.
