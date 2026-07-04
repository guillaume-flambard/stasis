// Persistence for AI analysis results (~/.stasis/analysis.json).
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { STASIS_DIR } from "../config.ts";
import type { AnalysisResult } from "./analyze.ts";

export const ANALYSIS_PATH = join(STASIS_DIR, "analysis.json");

export function loadAnalysis(): AnalysisResult | null {
  try {
    if (!existsSync(ANALYSIS_PATH)) return null;
    return JSON.parse(readFileSync(ANALYSIS_PATH, "utf8")) as AnalysisResult;
  } catch {
    return null;
  }
}

export function saveAnalysis(a: AnalysisResult): void {
  writeFileSync(ANALYSIS_PATH, JSON.stringify(a, null, 2) + "\n");
}
