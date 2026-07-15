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

- **Public-ready Phase 1** (decouple from author): config `goal {statement, deadline}` replaces the hardcoded `€2500/mo Dec 2026` north-star (migrates old `northStarDeadline`); `analyze` prompts now use the user's goal + emit `alignment` (universal source: precedence override > analysis.alignment > vault > 0.5); `urgency` reads `goal.deadline` (null → neutral). `stasis init` guided wizard + auto first-run; `adapters/detect.ts` capability readout (git/claude-logs/AI/vault/paperclip) + dashboard hint when no AI. Spec: [docs/superpowers/specs/2026-07-15-public-ready-design.md](docs/superpowers/specs/2026-07-15-public-ready-design.md). 114 tests. **Phase 2 (deferred, per owner):** filesystem Tier-0 + drop the `isGit` gate so ANY folder (non-tech, no git) ranks — subsumes the non-git-ventures task.

## Left / candidates
- ~~**snooze state**: set-aside project (largo-ai) still routes as hop — no exclude-from-route.~~ ✅ `stasis snooze <project>` / `stasis unsnooze <project>` / `--list` / `--clear`. Snoozed projects still score with a `😴` indicator but are excluded from routing, deferred, and switch menu.
- ~~**shadow AI**: background monitor that detects scatter, quota critical, focus overdue, hot projects, sprint block completion.~~ ✅ `stasis watch` (foreground/daemon/once/status/stop). Five detectors, macOS notifications for urgent events, per-project sprint history tracking. Skill reads `shadow-advice.json` at start.
- ~~**claude-mem adapter** (velocity/warm-to-resume).~~ ✅ `adapters/claudemem.ts` reads `~/.claude-mem/claude-mem.db` (bun:sqlite, read-only, 0 dep): per-project recent observation count + days-since. Blends into `momentum` (`min(daysSinceCommit, daysSinceObs)`) so a project you're actively reasoning about but haven't committed still reads warm. Exposed in `score --json.mem`. Graceful-skip if DB absent. Verified feeding; currently latent on git-scored repos (git commits ≥ recent than mem obs on all of them today) — fires when a repo goes commit-cold while mem-warm.
- ~~**Paperclip adapter** (feature %done → proximity).~~ ✅ `adapters/paperclip.ts`: shells out to `paperclipai` (CLI handles local auth), `company list` + parallel `issue list -C <id>` → done/(non-cancelled total) = ground-truth %done. Feeds `proximity` above AI analysis (`Paperclip > analysis > git-proxy`). Config `paperclip:{enabled,companyMap}` (default off; `companyMap` maps names auto-normalization can't bridge, e.g. `"Largo IA"→"largo-ai"`). 5-min TTL cache at `~/.stasis/paperclip-cache.json` (fetch is ~0.9s; warm run drops to ~1.4s). Graceful-skip if disabled/server-down/CLI-missing. Pure `resolveTargets`/`computeInfo` unit-tested; verified live (largo-ai 31/37 → proximity 0.838). 107 tests pass.
- **Non-git ventures blind spot**: Paperclip computes %done for blueowl (8/8), paykit (0/10), echo-travel (1/13) too, but those dirs aren't git repos so `buildSignals(...).filter(s=>s.isGit)` drops them — their real completion is invisible. Same class as the off-portfolio focus gap. Candidate: surface non-git venture dirs that have Paperclip/mem signal.
- Tune AI-analysis vs engagement weight.
- Tamagui dashboard over JSON (V2).
- Quota caps in config are rough until corrected vs `/usage`.
