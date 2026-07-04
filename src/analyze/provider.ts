// Model-agnostic JSON-completion providers. Default = Ollama (local, free).
// Also OpenAI-compatible (Codex/Kimi/OpenAI/LM Studio) and Anthropic.
// Every provider returns a parsed JSON object from a system+user prompt.
import type { AnalyzeConfig } from "../types.ts";

export interface ChatOpts {
  model?: string; // override cfg.model (e.g. fastModel)
  temperature?: number;
}

export interface AnalyzeProvider {
  readonly label: string;
  /** Send system+user, get back a parsed JSON object (never throws on prose). */
  chatJson(system: string, user: string, opts?: ChatOpts): Promise<any>;
  /** Cheap reachability probe. */
  ping(): Promise<boolean>;
}

/** Best-effort JSON extraction: direct parse, else first {...} / [...] block. */
export function extractJson(text: string): any {
  const t = (text ?? "").trim();
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const start = t.search(/[[{]/);
  if (start === -1) return {};
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  const end = t.lastIndexOf(close);
  if (end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  return {};
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await p;
  } finally {
    clearTimeout(timer);
  }
}

class OllamaProvider implements AnalyzeProvider {
  readonly label: string;
  constructor(private cfg: AnalyzeConfig) {
    this.label = `ollama:${cfg.model}`;
  }
  async ping(): Promise<boolean> {
    try {
      const r = await fetch(`${this.cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
      return r.ok;
    } catch {
      return false;
    }
  }
  async chatJson(system: string, user: string, opts?: ChatOpts): Promise<any> {
    const body = {
      model: opts?.model ?? this.cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
      think: false, // reasoning models: keep the answer in content, not thinking
      format: "json",
      options: { temperature: opts?.temperature ?? this.cfg.temperature, num_ctx: this.cfg.numCtx },
    };
    const r = await fetch(`${this.cfg.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
    const d = (await r.json()) as any;
    return extractJson(d?.message?.content ?? "");
  }
}

class OpenAICompatProvider implements AnalyzeProvider {
  readonly label: string;
  constructor(private cfg: AnalyzeConfig) {
    this.label = `openai:${cfg.model}`;
  }
  async ping(): Promise<boolean> {
    return !!this.cfg.apiKey;
  }
  async chatJson(system: string, user: string, opts?: ChatOpts): Promise<any> {
    const r = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey ?? ""}`,
      },
      body: JSON.stringify({
        model: opts?.model ?? this.cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: opts?.temperature ?? this.cfg.temperature,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`openai-compat ${r.status}: ${await r.text()}`);
    const d = (await r.json()) as any;
    return extractJson(d?.choices?.[0]?.message?.content ?? "");
  }
}

class AnthropicProvider implements AnalyzeProvider {
  readonly label: string;
  constructor(private cfg: AnalyzeConfig) {
    this.label = `anthropic:${cfg.model}`;
  }
  async ping(): Promise<boolean> {
    return !!this.cfg.apiKey;
  }
  async chatJson(system: string, user: string, opts?: ChatOpts): Promise<any> {
    const r = await fetch(`${this.cfg.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: opts?.model ?? this.cfg.model,
        max_tokens: 1024,
        temperature: opts?.temperature ?? this.cfg.temperature,
        system: system + "\nRespond with ONLY a JSON object.",
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);
    const d = (await r.json()) as any;
    return extractJson(d?.content?.[0]?.text ?? "");
  }
}

export function makeProvider(cfg: AnalyzeConfig): AnalyzeProvider {
  switch (cfg.provider) {
    case "openai":
      return new OpenAICompatProvider(cfg);
    case "anthropic":
      return new AnthropicProvider(cfg);
    case "ollama":
    default:
      return new OllamaProvider(cfg);
  }
}
