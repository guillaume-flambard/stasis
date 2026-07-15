# stasis — progress

Anti-scatter CLI: scores ~98 local projects, models Claude quota, routes multi-project sprints. Read-only; deterministic scoring (zero tokens), AI only in `stasis analyze`.

## Done
- **Spine**: `stasis` dashboard, `score`, `usage`, `quota` — all `--json`. Usage parser dedups by `message.id` (fixed 2.4x token inflation), caches by mtime.
- **Vault adapter**: joins `~/Vault/01-Projects/*.md` to repos, derives roi/alignment from tags. Precedence: override > AI > vault > 0.5.
- **Engagement factor**: log-scaled 21d output-token investment; highest weight (.22). Ranks actively-worked repos with no Vault note.
- **Quota honest + self-calibrating**: `quota --set week=% 5h=%` derives personal cap from real burn. No invented caps.
- **AI analysis** (`analyze`): Ollama (qwen3.5:9b) per-project deep pass + portfolio pass. Real ROI/%done/blocker/nextAction.
- **Focus loop** (`focus set/review/clear`): commit ONE bet + kill criterion for a horizon; fidelity = % tokens actually on focus; ⚠ scattering <60%; overdue forces verdict.
- **Routed multi-project sprint** (`core/route.ts`, `sprint --hours N`): anchor (focus) → ROI-per-token hops → return leg. Per-block est-tokens (median of real daily output) + est-minutes. Quota-bounded budget; below-line = deferred w/ honest reason. Dead/ROI<2 never routed.
- **`/stasis` skill**: decision coach — branches on focus, narrates the route.
- **Focus↔route coherence** (P0 fix): a committed focus that isn't a scored git project (a non-code bet like a job, or an inactive repo) used to be invisible — banner said n8n, route silently anchored elsewhere. Now the route anchors the commitment itself (off-portfolio block 1, ~0 tok for non-code) and hops portfolio work around it; `focus.traceable` flags non-code bets so fidelity is `null` "judged at verdict" instead of a false "0% ⚠ scattering". `route.ts · focus.ts · sprint.ts · cli.ts · watch.ts` + tests (91 pass).
- **Typecheck restored**: added `bun-types` + `tsconfig types:["bun-types"]` — `tsc --noEmit` was silently broken (missing node/bun globals). Now clean.

## Left / candidates
- ~~**snooze state**: set-aside project (largo-ai) still routes as hop — no exclude-from-route.~~ ✅ `stasis snooze <project>` / `stasis unsnooze <project>` / `--list` / `--clear`. Snoozed projects still score with a `😴` indicator but are excluded from routing, deferred, and switch menu.
- ~~**shadow AI**: background monitor that detects scatter, quota critical, focus overdue, hot projects, sprint block completion.~~ ✅ `stasis watch` (foreground/daemon/once/status/stop). Five detectors, macOS notifications for urgent events, per-project sprint history tracking. Skill reads `shadow-advice.json` at start.
- ~~**claude-mem adapter** (velocity/warm-to-resume).~~ ✅ `adapters/claudemem.ts` reads `~/.claude-mem/claude-mem.db` (bun:sqlite, read-only, 0 dep): per-project recent observation count + days-since. Blends into `momentum` (`min(daysSinceCommit, daysSinceObs)`) so a project you're actively reasoning about but haven't committed still reads warm. Exposed in `score --json.mem`. Graceful-skip if DB absent. Verified feeding; currently latent on git-scored repos (git commits ≥ recent than mem obs on all of them today) — fires when a repo goes commit-cold while mem-warm.
- **Paperclip adapter** (feature %done → proximity) — DEFERRED: server at 127.0.0.1:3100 is down, JSON shape unobservable, can't verify end-to-end. Design ready (`company list --json` → ids, `issue list -C <id> --json` → closed/total; precedence override > Paperclip > AI analysis > git-proxy). Build when the server is up.
- Tune AI-analysis vs engagement weight.
- Tamagui dashboard over JSON (V2).
- Quota caps in config are rough until corrected vs `/usage`.
