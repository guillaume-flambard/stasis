import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanFsInfo, scanFs } from "./fs.ts";

const DAY_MS = 86_400_000;
const NOW = 1_784_000_000_000;
let root: string;

function write(rel: string, content = "x", ageDays = 0) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  const t = (NOW - ageDays * DAY_MS) / 1000;
  utimesSync(p, t, t);
}

beforeAll(() => {
  root = join(tmpdir(), `stasis-fs-${NOW}-${Math.round(Math.random() * 1e9)}`);
  mkdirSync(root, { recursive: true });
  // a "project" folder: real work + noise that must be ignored
  write("proj/notes.md", "hello", 2);
  write("proj/deck.key", "x", 9);
  write("proj/src/app.ts", "x", 5);
  write("proj/node_modules/dep/index.js", "x", 0); // freshest, but must be ignored
  write("proj/dist/bundle.js", "x", 0); // build output, ignored
  write("proj/.hidden/secret.txt", "x", 0); // hidden dir, ignored
  // a deep file past MAX_DEPTH (root=0 → a/b/c/d is depth 4)
  write("proj/a/b/c/d/deep.txt", "x", 0);
  // a second project, untouched for a long time
  write("stale/old.md", "x", 200);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("scanFsInfo", () => {
  test("recency comes from the newest real file, not from noise", () => {
    const info = scanFsInfo(join(root, "proj"), NOW);
    // node_modules/dist/.hidden are all 0d but ignored → newest real file is 2d
    expect(info.daysSinceModified).toBe(2);
  });

  test("ignores dependency and build trees in the file count", () => {
    const info = scanFsInfo(join(root, "proj"), NOW);
    // notes.md, deck.key, src/app.ts — not node_modules, dist, .hidden, or the deep file
    expect(info.fileCount).toBe(3);
  });

  test("reports dominant file kinds", () => {
    const info = scanFsInfo(join(root, "proj"), NOW);
    expect(info.kinds).toContain(".md");
    expect(info.kinds).not.toContain(".js"); // only existed inside ignored dirs
  });

  test("a missing folder yields empty info, never throws", () => {
    const info = scanFsInfo(join(root, "does-not-exist"), NOW);
    expect(info.daysSinceModified).toBeNull();
    expect(info.fileCount).toBe(0);
  });

  test("a long-untouched folder reports its real age", () => {
    expect(scanFsInfo(join(root, "stale"), NOW).daysSinceModified).toBe(200);
  });
});

describe("scanFs", () => {
  test("maps every project dir by name", () => {
    const m = scanFs(root, NOW);
    expect(m.has("proj")).toBe(true);
    expect(m.has("stale")).toBe(true);
    expect(m.get("proj")?.daysSinceModified).toBe(2);
  });
});
