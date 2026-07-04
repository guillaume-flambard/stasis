// Read-only Obsidian Vault adapter. Parses ~/Vault/01-Projects/*.md frontmatter
// and derives ROI + north-star alignment from tags (Goals.md north-star =
// passive, self-serve income). Joins notes to project dirs via the `repo:` field,
// then filename, then any ~/projects/<dir> body mention. Graceful-skips if absent.
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface VaultInfo {
  title: string;
  status: string;
  tags: string[];
  roi: number | undefined; // 0..1, undefined if no known tags
  alignment: number | undefined; // 0..1
  note: string; // filename
}

// tag → { roi potential, north-star (passive/self-serve) alignment }, both 0..1.
const TAG_WEIGHTS: Record<string, { roi: number; align: number }> = {
  saas: { roi: 0.9, align: 1.0 },
  business: { roi: 0.85, align: 0.9 },
  payments: { roi: 0.85, align: 0.85 },
  devtools: { roi: 0.8, align: 0.9 },
  shipped: { roi: 0.7, align: 0.7 },
  edtech: { roi: 0.6, align: 0.6 },
  ai: { roi: 0.65, align: 0.7 },
  rag: { roi: 0.6, align: 0.7 },
  security: { roi: 0.6, align: 0.7 },
  cms: { roi: 0.5, align: 0.6 },
  marketing: { roi: 0.5, align: 0.5 },
  infra: { roi: 0.45, align: 0.5 },
  mobile: { roi: 0.5, align: 0.45 },
  tourism: { roi: 0.5, align: 0.35 },
  "koh-phangan": { roi: 0.45, align: 0.3 },
  template: { roi: 0.25, align: 0.2 },
};

/** Extract the YAML frontmatter block (between the first pair of --- lines). */
function frontmatter(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  return end === -1 ? null : text.slice(3, end);
}

function field(fm: string, key: string): string | null {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1]!.trim() : null;
}

function parseTags(fm: string): string[] {
  const raw = field(fm, "tags");
  if (!raw) return [];
  return raw
    .replace(/[[\]"']/g, "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/** Candidate project dir names this note refers to (lowercased). */
function candidates(fm: string, filename: string, body: string): string[] {
  const out: string[] = [];
  const repo = field(fm, "repo");
  if (repo) {
    const first = repo.split(/[\s(]/)[0]; // "echo (phanganpass)" -> "echo"
    if (first) out.push(first.toLowerCase());
  }
  out.push(filename.replace(/\.md$/i, "").toLowerCase());
  for (const m of body.matchAll(/~\/projects\/([A-Za-z0-9._-]+)/g)) {
    out.push(m[1]!.toLowerCase());
  }
  return [...new Set(out)];
}

function deriveFactors(tags: string[], status: string): { roi?: number; align?: number } {
  let roi: number | undefined;
  let align: number | undefined;
  for (const t of tags) {
    const w = TAG_WEIGHTS[t];
    if (!w) continue;
    roi = roi == null ? w.roi : Math.max(roi, w.roi);
    align = align == null ? w.align : Math.max(align, w.align);
  }
  // Evergreen = maintenance/reference, not a growth bet → discount ROI.
  if (status === "evergreen" && roi != null) roi *= 0.6;
  return { roi, align };
}

/** Map of lowercased project-dir name → VaultInfo. Empty if vault missing. */
export function loadVault(vaultDir: string): Map<string, VaultInfo> {
  const map = new Map<string, VaultInfo>();
  const dir = join(vaultDir, "01-Projects");
  if (!existsSync(dir)) return map;

  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith(".md") || f.name === "README.md") continue;
    let text: string;
    try {
      text = readFileSync(join(dir, f.name), "utf8");
    } catch {
      continue;
    }
    const fm = frontmatter(text);
    if (!fm) continue;
    if ((field(fm, "type") ?? "project") !== "project") continue;

    const tags = parseTags(fm);
    const status = (field(fm, "status") ?? "").toLowerCase();
    const { roi, align } = deriveFactors(tags, status);
    const info: VaultInfo = {
      title: field(fm, "title") ?? f.name.replace(/\.md$/i, ""),
      status,
      tags,
      roi,
      alignment: align,
      note: f.name,
    };
    const body = text.slice(fm.length);
    for (const dirName of candidates(fm, f.name, body)) {
      // First writer wins (repo-field notes are scanned in dir order; don't clobber).
      if (!map.has(dirName)) map.set(dirName, info);
    }
  }
  return map;
}
