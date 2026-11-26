import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDataDir, startFixtureServer, seedEntry, fixtureMeta } from "./helpers.js";
import { dataDir, designDir, stagingDir, webSlug } from "../src/lib/paths.js";
import { readAnalysis } from "../src/lib/meta.js";
import { openDb, searchDesigns } from "../src/lib/db.js";
import { addWeb, shouldReplace } from "../src/add.js";

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

test("an add is refused while another add of the same page holds its lock, and the entry is left alone", async () => {
  tempDataDir();
  const slug = await oldEntry();
  const before = snapshot(designDir(slug));
  fs.mkdirSync(path.join(dataDir(), ".locks", slug), { recursive: true });
  await assert.rejects(() => addWeb(base, { force: true }), /still being captured/);
  await assert.rejects(() => addWeb(base), /still being captured/);
  assert.deepEqual(snapshot(designDir(slug)), before);
});

test("a lock left by a killed run is taken over after 15 minutes, and released after the add", async () => {
  tempDataDir();
  const lock = path.join(dataDir(), ".locks", webSlug(base));
  fs.mkdirSync(lock, { recursive: true });
  const t = new Date(Date.now() - 16 * 60_000);
  fs.utimesSync(lock, t, t);
  const { meta } = await addWeb(base);
  assert.equal(meta.status, "complete");
  assert.ok(!fs.existsSync(lock));
});

test("a forced add of a page with no entry yet is a plain add: a failed review keeps the capture", async () => {
  tempDataDir();
  process.env.FAKE_CLAUDE_ALWAYS_BAD = "1";
  const { slug, meta } = await addWeb(base, { force: true });
  assert.equal(meta.status, "needs-analysis");
  assert.ok(fs.existsSync(path.join(designDir(slug), "meta.json")));
});

test("a forced add is refused while a capture's young folder has no details yet, and leaves it", async () => {
  tempDataDir();
  const dir = designDir(webSlug(base));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "desktop-fold.png"), "being written");
  await assert.rejects(() => addWeb(base, { force: true }), /still being captured/);
  assert.ok(fs.existsSync(path.join(dir, "desktop-fold.png")));
});

test("an interrupted swap is undone: the old entry comes back, however old, instead of being deleted", async () => {
  tempDataDir();
  const slug = await oldEntry();
  const before = snapshot(designDir(slug));
  fs.mkdirSync(stagingDir(), { recursive: true });
  const setAside = path.join(stagingDir(), `replaced.999.1.${slug}`); // killed between the two renames
  fs.renameSync(designDir(slug), setAside);
  const t = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(setAside, t, t);
  await assert.rejects(() => addWeb(`${base}missing-page`, { force: true }), /HTTP 404/); // any add recovers
  assert.deepEqual(snapshot(designDir(slug)), before);
  assert.ok(!fs.existsSync(setAside));
});

test("a stray file in staging doesn't stop a forced re-capture", async () => {
  tempDataDir();
  await oldEntry();
  fs.mkdirSync(stagingDir(), { recursive: true });
  fs.writeFileSync(path.join(stagingDir(), ".DS_Store"), "x");
  const { meta } = await addWeb(base, { force: true });
  assert.equal(meta.status, "complete");
});

test("a partial re-capture never replaces a complete entry; anything else may", () => {
  assert.equal(shouldReplace("complete", "partial"), false);
  assert.equal(shouldReplace("complete", "complete"), true);
  assert.equal(shouldReplace("partial", "partial"), true);
  assert.equal(shouldReplace("needs-analysis", "partial"), true);
});
