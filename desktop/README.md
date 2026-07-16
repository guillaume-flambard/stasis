# stasis desktop

Cross-platform (Tauri v2) live dashboard for [stasis](../). It shells out to the
`stasis` CLI (`--json`) and shows Focus · Quota · Today's route · Switch options ·
Scores, refreshing every 5s. Read-only for now.

## Prerequisites

- The `stasis` binary on PATH (or at `~/.local/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin`) — build it from the repo root with `bun run build`.
- Rust toolchain + Node.

## Run (dev)

```bash
cd desktop
npm install
npm run tauri dev      # opens the app window
```

## Build a distributable

```bash
npm run tauri build    # → .dmg / .msi / .AppImage in src-tauri/target/release/bundle
```

## Background / menu bar

stasis lives in the menu bar. Closing the window **hides** it — the app stays
resident; quitting is an explicit choice from the tray menu.

Tray menu: **Open dashboard** · **Start at login** (toggle) · **Quit stasis**.
Hovering the icon shows the at-a-glance line: quota gate + 5h burn + how faithful
you're being to your commitment.

Every 2 minutes the app runs `stasis watch --once`. The CLI owns detection *and*
urgent notifications (scatter / quota critical / focus overdue — the only three
kinds that interrupt you); the app just drives the tick and refreshes the tooltip.

> **Don't also run `stasis watch --daemon`** while the app is running, or both
> will tick and you'll be notified twice. Pick one owner.

## How it talks to stasis

The Rust command `run_stasis(command)` (`src-tauri/src/lib.rs`) runs
`stasis <command> --json` for a whitelist of read-only subcommands
(`score`, `sprint`, `focus`, `quota`, `usage`) and returns the JSON. All
rendering lives in `src/App.tsx`. No business logic in Rust — the CLI is the
single source of truth.
