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

> ### ⚠️ Known: no tray icon on macOS 26 (Tahoe)
>
> The menu-bar icon does not appear on macOS Tahoe. This is an **upstream bug**
> ([tauri-apps/tray-icon#273](https://github.com/tauri-apps/tray-icon/issues/273),
> also [tauri#13770](https://github.com/tauri-apps/tauri/issues/13770)) — open,
> no fix, no workaround. It affects both `tauri dev` and the bundled `.app`.
> Verified on 26.5.2 with tauri 2.11.5 / tray-icon 0.24.1 (both latest): the icon
> loads, the tray builds, `set_visible(true)` returns Ok — and nothing renders.
> Don't re-debug this; it works on Sequoia and will work again when upstream fixes it.
>
> **What still works without it:** background residency (the 120s loop) and the
> urgent notifications — which are the actual anti-scatter interrupt. The tray was
> the at-a-glance affordance, not the mechanism.
>
> Because the tray menu can't be relied on as the way back in, **clicking the Dock
> icon re-opens the hidden window**.

stasis stays resident. Closing the window **hides** it; quitting is an explicit
choice (tray menu where the tray works, or Cmd-Q).

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
