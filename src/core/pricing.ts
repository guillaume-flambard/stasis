export interface Rate {
  input: number;
  output: number;
  /** 5m ephemeral cache write — billed at 1.25× input. */
  cacheWrite5m: number;
  /** 1h ephemeral cache write — billed at 2× input. */
  cacheWrite1h: number;
  cacheRead: number;
}

export interface ModelRate {
  match: string; // substring match (case-insensitive)
  rate: Rate;
  /** Fast mode output multiplier (e.g. 1.8x for sonnet). */
  fastMultiplier: number;
}

const RATES: ModelRate[] = [
  // Claude Opus 4.x
  { match: "opus-4-8",      rate: { input: 15, output: 75,  cacheWrite5m: 18.75, cacheWrite1h: 30,  cacheRead: 1.5 },  fastMultiplier: 2.0 },
  { match: "opus-4-7",      rate: { input: 15, output: 75,  cacheWrite5m: 18.75, cacheWrite1h: 30,  cacheRead: 1.5 },  fastMultiplier: 2.0 },
  { match: "opus-4",        rate: { input: 15, output: 75,  cacheWrite5m: 18.75, cacheWrite1h: 30,  cacheRead: 1.5 },  fastMultiplier: 2.0 },
  { match: "opus",          rate: { input: 15, output: 75,  cacheWrite5m: 18.75, cacheWrite1h: 30,  cacheRead: 1.5 },  fastMultiplier: 2.0 },

  // Claude Sonnet 5.x
  { match: "sonnet-5",      rate: { input: 3,  output: 15,  cacheWrite5m: 3.75,  cacheWrite1h: 6,   cacheRead: 0.3 },  fastMultiplier: 1.8 },
  // Claude Sonnet 4.x (4.5, 4.6, etc.)
  { match: "sonnet-4",      rate: { input: 3,  output: 15,  cacheWrite5m: 3.75,  cacheWrite1h: 6,   cacheRead: 0.3 },  fastMultiplier: 1.8 },
  { match: "sonnet",        rate: { input: 3,  output: 15,  cacheWrite5m: 3.75,  cacheWrite1h: 6,   cacheRead: 0.3 },  fastMultiplier: 1.8 },

  // Claude Haiku 3.x / 4.x
  { match: "haiku",         rate: { input: 0.8, output: 4,  cacheWrite5m: 1,     cacheWrite1h: 1.6, cacheRead: 0.08 }, fastMultiplier: 1.5 },
];

/** Synthetic/internal messages — no meaningful cost. */
const SYNTHETIC_RATE: Rate = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

const FALLBACK: ModelRate = RATES.find((r) => r.match === "opus")!;

export interface RateResult {
  rate: Rate;
  /** Whether fast-mode pricing was applied. */
  isFast: boolean;
}

export function resolveModel(model: string): RateResult | null {
  if (!model || model === "<synthetic>") return null;
  const m = model.toLowerCase();
  for (const entry of RATES) {
    if (m.includes(entry.match)) {
      return { rate: entry.rate, isFast: false };
    }
  }
  return { rate: FALLBACK.rate, isFast: false };
}

export function rateFor(model: string): Rate {
  return resolveModel(model)?.rate ?? FALLBACK.rate;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  /** 5m ephemeral cache write tokens (billed at cacheWrite5m). */
  cacheWrite5m: number;
  /** 1h ephemeral cache write tokens (billed at cacheWrite1h = 2× input). */
  cacheWrite1h: number;
  cacheRead: number;
  /** When true, fast-mode pricing applies. */
  isFast: boolean;
}

/** Cost in USD for a token breakdown under a given model. */
export function costOf(model: string, t: TokenBreakdown): number {
  const result = resolveModel(model);
  if (!result) return 0; // synthetic / unknown — $0

  let { rate } = result;
  if (t.isFast) {
    // Apply fast multiplier to output tokens only (OpenUsage convention).
    const fm = RATES.find((r) => model.toLowerCase().includes(r.match))?.fastMultiplier ?? 1.5;
    rate = { ...rate, output: rate.output * fm };
  }

  return (
    (t.input * rate.input +
      t.output * rate.output +
      t.cacheWrite5m * rate.cacheWrite5m +
      t.cacheWrite1h * rate.cacheWrite1h +
      t.cacheRead * rate.cacheRead) /
    1_000_000
  );
}
