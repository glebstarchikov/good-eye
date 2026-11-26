import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { tempDataDir } from "./helpers.js";
import { dataDir, designDir, designsDir, dbPath, makeSlug, pageKey, repoRoot, stagingDir, webSlug } from "../src/lib/paths.js";

test("dataDir honors GOOD_EYE_DATA_DIR at call time", () => {
  const tmp = tempDataDir();
  assert.equal(dataDir(), tmp);
  assert.equal(designDir("x--2026-01-01"), path.join(tmp, "designs", "x--2026-01-01"));
  assert.equal(dbPath(), path.join(tmp, "catalog.db"));
});

test("dataDir defaults to ~/.good-eye/data, never the checkout", () => {
  delete process.env.GOOD_EYE_DATA_DIR;
  assert.equal(dataDir(), path.join(os.homedir(), ".good-eye", "data"));
});

// The negative half of the above, and the one that actually matters: when good-eye runs
// as an installed plugin, repoRoot is the versioned plugin cache dir, which is replaced on
// every version bump. A repo-relative default would strand the library there on upgrade.
test("dataDir never resolves inside the checkout", () => {
  delete process.env.GOOD_EYE_DATA_DIR;
  assert.ok(
    !dataDir().startsWith(repoRoot),
    `dataDir() must not live under repoRoot (got ${dataDir()})`,
  );
});

test("makeSlug normalizes url-ish names and appends date", () => {
  const d = new Date("2026-07-11T12:00:00Z");
  assert.equal(makeSlug("https://www.Stripe.com/", d), "stripe-com--2026-07-11");
  assert.equal(makeSlug("My Cool App!", d), "my-cool-app--2026-07-11");
});

test("makeSlug never leaves a trailing dash when the 60-char cap lands on a separator", () => {
  const d = new Date("2026-07-11T12:00:00Z");
  assert.equal(makeSlug("a".repeat(59) + " b", d), `${"a".repeat(59)}--2026-07-11`);
});

// The same-page rule. The capture worker in good-eye-app keeps a copy of pageKey; its tests use these cases.
test("pageKey: www, protocol, query, # part and a trailing slash don't make a different page", () => {
  const key = pageKey("https://linear.app/changelog");
  for (const url of [
    "http://linear.app/changelog", "https://www.linear.app/changelog", "https://LINEAR.app/changelog/",
    "https://linear.app/changelog?utm_source=x", "https://linear.app/changelog#latest",
  ]) assert.equal(pageKey(url), key, url);
  assert.equal(pageKey("https://www.stripe.com/"), "stripe.com");
  assert.equal(pageKey("https://stripe.com"), "stripe.com");
});

test("pageKey: another path, path case or subdomain is a different page", () => {
  const key = pageKey("https://linear.app/changelog");
  for (const url of [
    "https://linear.app/", "https://linear.app/changelog/2026", "https://linear.app/Changelog",
    "https://docs.linear.app/changelog", "https://linear.app.evil.io/changelog",
  ]) assert.notEqual(pageKey(url), key, url);
});

test("webSlug names an entry by its page, with a short code, and the same page always gets the same name", () => {
  const d = new Date("2026-11-26T12:00:00Z");
  assert.match(webSlug("https://www.Stripe.com/", d), /^stripe-com-[0-9a-f]{6}--2026-11-26$/);
  assert.match(webSlug("https://linear.app/changelog", d), /^linear-app-changelog-[0-9a-f]{6}--2026-11-26$/);
  assert.equal(webSlug("http://www.linear.app/changelog/?ref=x#top", d), webSlug("https://linear.app/changelog", d));
});

test("webSlug: pages that clean up to the same words still get different names", () => {
  const d = new Date("2026-11-26T12:00:00Z");
  const long = "https://developer.apple.com/design/human-interface-guidelines/designing-for-";
  for (const [a, b] of [
    ["https://linear.app", "https://linear.app/changelog"],
    ["https://site.com/a_b", "https://site.com/a-b"],
    ["https://site.com/Pricing", "https://site.com/pricing"],
    ["https://my-site.com", "https://my.site.com"],
    [`${long}ios`, `${long}macos`],
  ]) assert.notEqual(webSlug(a, d), webSlug(b, d), `${a} vs ${b}`);
});

test("webSlug keeps names short and never leaks a dash into the code or the date", () => {
  const d = new Date("2026-11-26T12:00:00Z");
  const slug = webSlug(`https://example.com/${"a".repeat(80)}`, d);
  assert.ok(slug.length <= 60 + "--2026-11-26".length, slug);
  assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{6}--2026-11-26$/);
  assert.match(webSlug(`https://example.com/${"a".repeat(45)}-b`, d), /^[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{6}--/);
});

test("staging sits beside the library, never inside designs/, so nothing that lists entries sees it", () => {
  tempDataDir();
  assert.equal(path.dirname(stagingDir()), dataDir());
  assert.ok(!stagingDir().startsWith(designsDir() + path.sep));
});
