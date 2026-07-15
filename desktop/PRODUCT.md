# PRODUCT.md — stasis desktop

## Register

**Product.** A live desktop dashboard (Tauri) over the stasis CLI. Design serves the task: read state fast, decide, get back to work. Not a marketing surface.

## Users & Purpose

Developers and indie AI-app makers juggling many local projects at once, mid work-session, hitting subscription/token limits before anything ships. The app is their **command center**: at a glance — what did I commit to (Focus), how much quota is left, what's today's routed plan across projects, what could I switch to, and how does everything rank. They open it to decide the next move and to stay honest about scatter.

Primary task on screen: **orient in <5 seconds**, then act in the terminal. The window is a heads-up display, not a place you linger.

## Brand personality

Precise · honest · calm-under-load. Developer-native. The tool disappears into the task. Numbers are the hero; chrome is quiet. Confidence without hype — it tells you the truth (0% scattering, quota near cap) without drama.

## Anti-references

- SaaS-cream marketing dashboards (soft shadows, pastel gradients, hero-metric cards).
- Crypto/fintech "glow" dashboards (neon gradients, glassmorphism everywhere).
- Playful consumer apps (rounded blobs, mascots, bounce).
- Generic terminal-green "hacker" skin — dark is right, but this is refined, not a CRT costume.

Closest in spirit: Linear (density + restraint), Raycast (calm dark, precise), a well-tuned trading terminal (data-first, status color used sparingly).

## Accessibility

Dark theme, body text ≥4.5:1. Status color (green/amber/red for quota gate + fidelity) never the *only* signal — always paired with a label or value. Full `prefers-reduced-motion` support (motion conveys refresh/state only).

## Strategic design principles

1. **Data is the interface.** Typography + alignment carry it; minimize boxes.
2. **Status color is semantic, never decorative.** Reserve green/amber/red for quota + fidelity + gate.
3. **One quiet accent** for the current/active thing (anchor, live pulse).
4. **Dense but scannable** — a heads-up display, one screen, no scrolling for the essentials.
