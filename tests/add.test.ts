import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDataDir, startFixtureServer, seedEntry, fixtureMeta } from "./helpers.js";
import { designDir, stagingDir, webSlug } from "../src/lib/paths.js";
import { readAnalysis } from "../src/lib/meta.js";
import { openDb, searchDesigns } from "../src/lib/db.js";
import { addWeb } from "../src/add.js";

const fakeClaude = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "librarian", "fake-claude.sh");
let base: string;
let close: () => void;

before(async () => {
  ({ base, close } = await startFixtureServer());
  process.env.GOOD_EYE_CLAUDE_BIN = fakeClaude;
  process.env.GOOD_EYE_DOM_TIMEOUT_MS = "2000";
  process.env.GOOD_EYE_PARSE_TIMEOUT_MS = "4000";
  process.env.GOOD_EYE_NAV_TIMEOUT_MS = "3000";
});
after(() => {
  close();
  for (const k of ["GOOD_EYE_CLAUDE_BIN", "GOOD_EYE_DOM_TIMEOUT_MS", "GOOD_EYE_PARSE_TIMEOUT_MS", "GOOD_EYE_NAV_TIMEOUT_MS"]) delete process.env[k];
});
beforeEach(() => {
  delete process.env.FAKE_CLAUDE_ALWAYS_BAD;
  delete process.env.FAKE_CLAUDE_ARGV;
});

/** Every file under dir with its contents, so "left as it was" can be checked exactly. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) {
      const p = path.join(e.parentPath, e.name);
      out[path.relative(dir, p)] = fs.readFileSync(p, "base64");
    }
  }
  return out;
}

/** A reviewed entry for the fixture home page, with a file only the old capture has. */
async function oldEntry(): Promise<string> {
  const { slug } = await addWeb(base);
  fs.writeFileSync(path.join(designDir(slug), "only-in-the-old-capture.txt"), "old");
  return slug;
}

function stagingLeftovers(): string[] {
  return fs.existsSync(stagingDir()) ? fs.readdirSync(stagingDir()) : [];
}

test("without force, addWeb captures and reviews into the entry's own folder", async () => {
  tempDataDir();
  const { slug, meta } = await addWeb(base, { note: "plain add" });
  assert.equal(slug, webSlug(base));
  assert.equal(meta.status, "complete");
  assert.ok(readAnalysis(slug).length >= 100);
  assert.deepEqual(stagingLeftovers(), []);
});

test("a forced re-capture replaces the entry once the new capture and its review both succeed", async () => {
  tempDataDir();
  const slug = await oldEntry();
  const { slug: again, meta } = await addWeb(base, { force: true });
  assert.equal(again, slug);
  assert.equal(meta.status, "complete");
  assert.ok(!fs.existsSync(path.join(designDir(slug), "only-in-the-old-capture.txt")), "the old entry is still there");
  assert.ok(readAnalysis(slug).length >= 100);
  assert.deepEqual(stagingLeftovers(), []);
  const db = openDb();
  assert.ok(searchDesigns(db, {}).some((h) => h.slug === slug));
  db.close();
});

test("a forced re-capture with no entry yet simply adds one", async () => {
  tempDataDir();
  const { slug, meta } = await addWeb(base, { force: true });
  assert.equal(meta.status, "complete");
  assert.ok(fs.existsSync(path.join(designDir(slug), "meta.json")));
});

test("a forced re-capture whose review fails leaves the old entry and its review as they were", async () => {
  tempDataDir();
  const slug = await oldEntry();
  const before = snapshot(designDir(slug));
  process.env.FAKE_CLAUDE_ALWAYS_BAD = "1";
  await assert.rejects(() => addWeb(base, { force: true }), /review failed/);
  assert.deepEqual(snapshot(designDir(slug)), before);
  assert.deepEqual(stagingLeftovers(), []);
});

test("a forced re-capture that can't load the page leaves the old entry as it was", async () => {
  tempDataDir();
  const url = `${base}missing-page`;
  const slug = webSlug(url);
  seedEntry(fixtureMeta({ slug, url, domain: "127.0.0.1" }), "An older review of this page. ".repeat(5));
  const before = snapshot(designDir(slug));
  await assert.rejects(() => addWeb(url, { force: true }), /HTTP 404/);
  assert.deepEqual(snapshot(designDir(slug)), before);
  assert.deepEqual(stagingLeftovers(), []);
});

test("a forced re-capture is reviewed in staging, outside the library, so nothing listing entries sees it", async () => {
  tempDataDir();
  await oldEntry();
  const argv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "argv-")), "argv");
  process.env.FAKE_CLAUDE_ARGV = argv;
  await addWeb(base, { force: true });
  const cwd = fs.readFileSync(argv, "utf8").split("\0")[0];
  assert.ok(cwd.startsWith(fs.realpathSync(stagingDir()) + path.sep), `reviewed in ${cwd}`);
});

test("staging copies untouched for 15 minutes are cleared; younger ones, still running elsewhere, are left", async () => {
  tempDataDir();
  await oldEntry();
  const stale = path.join(stagingDir(), "capture-killed");
  const live = path.join(stagingDir(), "capture-running");
  for (const d of [stale, live]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "desktop.png"), "x");
  }
  const t = new Date(Date.now() - 16 * 60_000);
  for (const p of [path.join(stale, "desktop.png"), stale]) fs.utimesSync(p, t, t);
  await addWeb(base, { force: true });
  assert.ok(!fs.existsSync(stale), "the abandoned staging copy is still there");
  assert.ok(fs.existsSync(path.join(live, "desktop.png")), "a running capture's staging copy was removed");
});
