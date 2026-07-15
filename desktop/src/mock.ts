// Sample data matching the stasis --json shapes, used when the app runs outside
// Tauri (a plain browser during design/dev) so the UI renders without the CLI.
export const MOCK: Record<string, unknown> = {
  sprint: {
    gate: "yellow",
    why: [
      "WHY paykit: high ROI (8/10), near shippable (7/10).",
      "WHEN: mid-week — pace it, don't spike (reset in 4d).",
      "HOW: drive one feature to merge within ~340k output tok, then stop.",
    ],
    switchOptions: [
      { name: "paykit-landing", roi: 8, score: 6.2, reason: "high ROI + warm/recent" },
      { name: "largo-ai", roi: 6, score: 5.9, reason: "near shippable + deadline pressure" },
      { name: "weave", roi: 4, score: 5.5, reason: "heavy active investment" },
      { name: "geo-forge", roi: 9, score: 5.0, reason: "high ROI + north-star fit" },
    ],
    route: {
      mode: "sustain",
      anchor: "paykit",
      budgetTokens: 340000,
      usedTokens: 250000,
      totalMinutes: 165,
      blocks: [
        { project: "paykit", kind: "anchor", task: "multi-tenant schema + API keys UI", stop: "ship it / one real use", why: "your anchor · ROI 8 · 85% done", roi: 8, estTokens: 150000, estMinutes: 100 },
        { project: "paykit-landing", kind: "hop", task: "paste Resend keys, deploy the waitlist", stop: "one mergeable checkpoint", why: "ROI 8 · best return-per-token here", roi: 8, estTokens: 40000, estMinutes: 25 },
        { project: "largo-ai", kind: "hop", task: "Stripe checkout wire-up, deploy", stop: "one mergeable checkpoint", why: "ROI 6 · same session", roi: 6, estTokens: 60000, estMinutes: 40 },
      ],
      deferred: [
        { project: "weave", roi: 4, reason: "lower ROI-per-token" },
        { project: "geo-forge", roi: 9, reason: "heavy (~90k) — next window" },
        { project: "memo-cc", roi: 0, reason: "ROI too low to justify a switch" },
      ],
      note: "Batch each block to its stop before hopping. The order minimizes cold-starts.",
    },
  },
  focus: {
    active: {
      focus: { project: "paykit", bet: "First paying customer by the sprint's end — checkout live + one real signup", kill: "Zero signups after launch week", horizonDays: 14 },
      daysElapsed: 5,
      daysLeft: 9,
      overdue: false,
      fidelity: 0.72,
      traceable: true,
      leaks: [{ name: "weave", tokens: 120000 }, { name: "largo-ai", tokens: 64000 }],
    },
  },
  quota: [
    { subscription: "claude_max_5x", calibrated: true, rolling5h: { tokens: 271000, cap: 482000, pct: 0.56 }, weekly: { tokens: 2100000, cap: 10700000, pct: 0.2 }, resetInDays: 4, gate: "yellow" },
  ],
  score: [
    { name: "paykit", score: 6.87, factors: { roi: 0.8, urgency: 0.6, proximity: 0.85, momentum: 0.9, effort: 0.7, alignment: 0.9, engagement: 0.8 }, daysSinceCommit: 0, costUsd: 90, paperclip: { percentDone: 0.85, done: 17, total: 20 } },
    { name: "largo-ai", score: 6.4, factors: { roi: 0.6, urgency: 0.7, proximity: 0.84, momentum: 0.8, effort: 0.6, alignment: 0.7, engagement: 0.9 }, daysSinceCommit: 0, costUsd: 2160, paperclip: { percentDone: 0.84, done: 31, total: 37 } },
    { name: "paykit-landing", score: 6.2, factors: { roi: 0.8, urgency: 0.5, proximity: 0.6, momentum: 0.85, effort: 0.9, alignment: 0.8, engagement: 0.5 }, daysSinceCommit: 1, costUsd: 12, paperclip: null },
    { name: "weave", score: 5.5, factors: { roi: 0.4, urgency: 0.3, proximity: 0.5, momentum: 0.77, effort: 0.5, alignment: 0.7, engagement: 0.95 }, daysSinceCommit: 7, costUsd: 1900, paperclip: null },
    { name: "geo-forge", score: 5.0, factors: { roi: 0.9, urgency: 0.4, proximity: 0.3, momentum: 0.6, effort: 0.7, alignment: 0.8, engagement: 0.4 }, daysSinceCommit: 3, costUsd: 0, paperclip: null },
    { name: "browser-router", score: 4.7, factors: { roi: 0.5, urgency: 0.3, proximity: 0.55, momentum: 0.63, effort: 0.8, alignment: 0.5, engagement: 0.3 }, daysSinceCommit: 11, costUsd: 12, paperclip: null },
    { name: "straysafe-v2", score: 4.3, factors: { roi: 0.4, urgency: 0.4, proximity: 0.35, momentum: 0.6, effort: 0.6, alignment: 0.4, engagement: 0.3 }, daysSinceCommit: 3, costUsd: 0, paperclip: null },
    { name: "memo-cc", score: 3.1, factors: { roi: 0, urgency: 0.2, proximity: 0.4, momentum: 0.63, effort: 0.9, alignment: 0.2, engagement: 0.2 }, daysSinceCommit: 11, costUsd: 0, paperclip: null },
  ],
};
