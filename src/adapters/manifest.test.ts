import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectsManifest, resolveProjectDirs } from "./manifest.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stasis-manifest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeManifest(body: string) {
  writeFileSync(join(dir, "PROJECTS.md"), body);
}

describe("parseProjectsManifest table awareness", () => {
  test("reads the manifest table", () => {
    writeManifest(
      ["| Name | Path | Status |", "|------|------|--------|", "| alpha | active/apps/alpha | active |"].join("\n"),
    );
    expect(parseProjectsManifest(dir)).toEqual([{ name: "alpha", path: "active/apps/alpha" }]);
  });

  test("skips the portfolio-lane table, whose columns mean something else", () => {
    writeManifest(
      [
        "| Name | Path | Status |",
        "|------|------|--------|",
        "| alpha | active/apps/alpha | active |",
        "",
        "| Lane | Projects |",
        "|------|----------|",
        "| now | foldready |",
        "| build | alpha, uni |",
        "| lab | infra |",
        "| incubate | three |",
        "| validate | two |",
        "| separate | one |",
      ].join("\n"),
    );
    const names = parseProjectsManifest(dir).map((e) => e.name);
    expect(names).toEqual(["alpha"]);
  });

  test("skips a second table whose first column is not a project name", () => {
    writeManifest(
      [
        "| Name | Path | Status |",
        "|------|------|--------|",
        "| alpha | active/apps/alpha | active |",
        "",
        "| Zone | Note |",
        "|------|------|",
        "| Vault | knowledge |",
      ].join("\n"),
    );
    expect(parseProjectsManifest(dir).map((e) => e.name)).toEqual(["alpha"]);
  });

  test("emits neither the header nor the separator row", () => {
    writeManifest(["| Name | Path |", "|------|------|", "| alpha | a |"].join("\n"));
    expect(parseProjectsManifest(dir).map((e) => e.name)).not.toContain("Name");
    expect(parseProjectsManifest(dir)).toHaveLength(1);
  });

  test("a missing manifest yields no entries", () => {
    expect(parseProjectsManifest(dir)).toEqual([]);
  });
});

describe("resolveProjectDirs path resolution", () => {
  test("category and structural containers are not independent projects", () => {
    writeManifest("| Name | Path |\n|------|------|\n| intentlane | products/intentlane |\n");
    for (const name of ["products", "tools", "clients", "infrastructure", "experiments", "active", "_external", "_worktrees", "_scratch", "_data", "_reports"]) {
      mkdirSync(join(dir, name), { recursive: true });
    }
    expect(resolveProjectDirs(dir)).toEqual([
      { name: "intentlane", path: join(dir, "products/intentlane") },
    ]);
  });

  test("reference and compatibility tables do not become scored projects", () => {
    writeManifest([
      "| Name | Path |", "|------|------|", "| uni | active/platform/uni |", "",
      "| Reference | Path |", "|-----------|------|", "| clone | external/clone |", "",
      "| Name | Target |", "|------|--------|", "| old-uni | active/platform/uni |",
    ].join("\n"));
    expect(parseProjectsManifest(dir)).toEqual([{ name: "uni", path: "active/platform/uni" }]);
  });

  test("resolves a manifest-relative path under projectsDir", () => {
    writeManifest(["| Name | Path |", "|------|------|", "| alpha | active/apps/alpha |"].join("\n"));
    expect(resolveProjectDirs(dir)).toContainEqual({ name: "alpha", path: join(dir, "active/apps/alpha") });
  });

  test("expands a leading ~ instead of nesting it under projectsDir", () => {
    writeManifest(["| Name | Path |", "|------|------|", "| apple | ~/Developer/apple-ai |"].join("\n"));
    const found = resolveProjectDirs(dir).find((e) => e.name === "apple");
    expect(found?.path).toBe(join(homedir(), "Developer/apple-ai"));
    expect(found?.path.startsWith(join(dir, "~"))).toBe(false);
  });

  test("passes an absolute path through untouched", () => {
    writeManifest(["| Name | Path |", "|------|------|", "| kollio | /opt/kollio |"].join("\n"));
    expect(resolveProjectDirs(dir)).toContainEqual({ name: "kollio", path: "/opt/kollio" });
  });

  test("does not invent a project named after a structural dir", () => {
    writeManifest(["| Name | Path |", "|------|------|", "| alpha | active/apps/alpha |"].join("\n"));
    mkdirSync(join(dir, "Library", "Caches"), { recursive: true });
    const names = resolveProjectDirs(dir).map((e) => e.name);
    expect(names).not.toContain("Library");
  });

  test("does not invent a project named after the drafts or upstream container", () => {
    writeManifest(
      [
        "| Name | Path | Status |",
        "|------|------|--------|",
        "| exploration | drafts/exploration | draft |",
        "| upstream-repo | upstream/some-clone | draft |",
        "",
        "| Name | Path | Kind | Status | Stack | Reference |",
        "|------|------|------|--------|-------|-----------|",
        "| root-citizen | ~/Developer/root-citizen | git | active | Swift | — |",
      ].join("\n"),
    );
    mkdirSync(join(dir, "drafts", "ideas"), { recursive: true });
    mkdirSync(join(dir, "upstream", "some-clone"), { recursive: true });
    const names = resolveProjectDirs(dir).map((e) => e.name);
    expect(names).not.toContain("drafts");
    expect(names).not.toContain("upstream");
    // The real children stay, and a root citizen outside projectsDir keeps its own name.
    expect(names).toContain("exploration");
    expect(names).toContain("upstream-repo");
    expect(names).toContain("root-citizen");
  });

  test("does not invent projects from underscore containers or the jobs alias", () => {
    writeManifest(["| Name | Path |", "|------|------|", "| alpha | alpha |"].join("\n"));
    for (const name of ["_external", "_worktrees", "_scratch", "_data", "_reports", "jobs"]) {
      mkdirSync(join(dir, name), { recursive: true });
    }
    const names = resolveProjectDirs(dir).map((e) => e.name);
    expect(names).toEqual(["alpha"]);
  });
});
