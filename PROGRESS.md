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

## Left / candidates
- ~~**snooze state**: set-aside project (largo-ai) still routes as hop — no exclude-from-route.~~ ✅ `stasis snooze <project>` / `stasis unsnooze <project>` / `--list` / `--clear`. Snoozed projects still score with a `😴` indicator but are excluded from routing, deferred, and switch menu.
- ~~**shadow AI**: background monitor that detects scatter, quota critical, focus overdue, hot projects, sprint block completion.~~ ✅ `stasis watch` (foreground/daemon/once/status/stop). Five detectors, macOS notifications for urgent events, per-project sprint history tracking. Skill reads `shadow-advice.json` at start.
- Paperclip + claude-mem adapters (feature %done, velocity) — staged, graceful-skip.
- Tune AI-analysis vs engagement weight.
- Tamagui dashboard over JSON (V2).
- Quota caps in config are rough until corrected vs `/usage`.
