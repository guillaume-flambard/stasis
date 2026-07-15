import { describe, test, expect } from "bun:test";
import { resolveTargets, computeInfo, type Company, type Issue } from "./paperclip.ts";

describe("resolveTargets", () => {
  const companies: Company[] = [
    { id: "1", name: "Blue Owl", status: "active", issuePrefix: "BLU" },
    { id: "2", name: "Largo IA", status: "active", issuePrefix: "LAR" },
    { id: "3", name: "PayKit", status: "active", issuePrefix: "PAY" },
    { id: "4", name: "Archived Co", status: "archived", issuePrefix: "ARC" },
  ];
  const repos = ["blueowl", "largo-ai", "paykit", "archived-co"];

  test("matches by normalized name (strips spaces/case)", () => {
    const t = resolveTargets(companies, repos, {});
    expect(t.find((x) => x.id === "1")?.dir).toBe("blueowl");
    expect(t.find((x) => x.id === "3")?.dir).toBe("paykit");
  });

  test("drops non-active companies", () => {
    const t = resolveTargets(companies, repos, {});
    expect(t.find((x) => x.id === "4")).toBeUndefined();
  });

  test("normalization cannot bridge IA vs AI — needs a companyMap override", () => {
    const auto = resolveTargets(companies, repos, {});
    expect(auto.find((x) => x.id === "2")).toBeUndefined(); // largoia != largoai
    const mapped = resolveTargets(companies, repos, { "Largo IA": "largo-ai" });
    expect(mapped.find((x) => x.id === "2")?.dir).toBe("largo-ai");
  });

  test("companyMap accepts an issue-prefix key too", () => {
    const t = resolveTargets(companies, repos, { LAR: "largo-ai" });
    expect(t.find((x) => x.id === "2")?.dir).toBe("largo-ai");
  });

  test("company with no matching repo is dropped", () => {
    const t = resolveTargets([{ id: "9", name: "Ghost", status: "active" }], repos, {});
    expect(t).toHaveLength(0);
  });
});

describe("computeInfo", () => {
  const issue = (status: string, hiddenAt: string | null = null): Issue => ({ status, hiddenAt });

  test("percentDone = done / non-cancelled total", () => {
    const info = computeInfo([issue("done"), issue("done"), issue("blocked"), issue("backlog")]);
    expect(info).toEqual({ percentDone: 0.5, done: 2, total: 4, open: 2 });
  });

  test("cancelled and hidden issues leave the denominator", () => {
    const info = computeInfo([
      issue("done"),
      issue("cancelled"),
      issue("todo", "2026-01-01T00:00:00Z"),
    ]);
    expect(info).toEqual({ percentDone: 1, done: 1, total: 1, open: 0 });
  });

  test("returns null when nothing is countable", () => {
    expect(computeInfo([])).toBeNull();
    expect(computeInfo([issue("cancelled")])).toBeNull();
  });
});
