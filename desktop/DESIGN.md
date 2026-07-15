# DESIGN.md — stasis desktop

## Theme

Refined dark, developer-native. Near-black neutral with a faint cool tint (not pure black, not terminal green). A heads-up display: hairline separators over heavy cards, generous negative space around dense data.

## Color (OKLCH)

Strategy: **Restrained** — tinted-neutral surfaces + one quiet accent; status colors are semantic only.

```
--bg        oklch(0.165 0.006 265)   /* app background */
--surface   oklch(0.205 0.008 265)   /* raised panels */
--surface-2 oklch(0.245 0.010 265)   /* hover / inset */
--line      oklch(0.285 0.010 265)   /* hairline borders */
--ink       oklch(0.955 0.004 265)   /* primary text  (>= 12:1) */
--muted     oklch(0.700 0.010 265)   /* secondary text (>= 4.7:1) */
--faint     oklch(0.520 0.010 265)   /* tertiary / lines of meta */

--accent    oklch(0.72 0.13 274)     /* periwinkle — anchor, live, score value */
--accent-dim oklch(0.42 0.07 274)

/* status — semantic, paired with a label/value, never decoration */
--ok    oklch(0.74 0.16 152)   /* green  */
--warn  oklch(0.80 0.14 78)    /* amber  */
--crit  oklch(0.66 0.20 22)    /* red    */
```

Accent is periwinkle, deliberately not blue (fintech reflex) or green (terminal reflex). Gate/fidelity use ok/warn/crit; the accent marks the *current/active* thing only.

## Typography

Contrast axis: **sans for UI + mono for data**.

- UI (labels, section headings, buttons): `Inter, system-ui, sans-serif`, 500/600 weight.
- Data (project names, numbers, routes, tokens): `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`.
- Fixed rem scale (product, not fluid): 11px meta · 13px body · 15px emphasis · 20px focus title · 26px hero number. Scale ratio ~1.2.
- Section headings: 11px, uppercase, tracking 0.08em, `--muted` — used once per region, not as decorative eyebrows.
- Tabular numerals (`font-variant-numeric: tabular-nums`) everywhere numbers align.

## Layout

Heads-up display, one screen (~1100×820), no scroll for essentials.

- **Top bar**: brand + live pulse + last-updated + quota gauges inline (compact).
- **Focus band** (full width, hero): the commitment — project, bet, day X/N, a fidelity meter. Not a card; a bordered band.
- **Main row (2col)**: left = **Route** (vertical timeline: anchor→hops→return, a real connecting rail, budget meter); right = **Switch by ROI** (compact ranked list).
- **Scores** (full width): dense mono table, tabular nums, subtle row hover.

Hairlines (`--line`) and spacing separate regions; avoid nested cards. Radius 12px on the few real panels, 6px on chips/controls. No radius ≥ 20px.

## Motion

150–220ms, ease-out (cubic-bezier(0.2, 0.8, 0.2, 1)). Live-refresh: a soft accent pulse on the header dot + a 120ms fade on changed values. Row/list entrances stagger only on first mount. `prefers-reduced-motion`: crossfade/instant, no transforms.

## Components / states

Quota gauge (track + fill, tone by pct), fidelity meter, route block (kind-marked, connecting rail), switch row, score row. Loading = skeleton lines, not spinners. Empty focus = a quiet prompt, not "nothing here". Error = a single inline strip.
