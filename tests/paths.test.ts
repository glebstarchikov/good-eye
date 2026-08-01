import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { tempDataDir } from "./helpers.js";
import { dataDir, designDir, dbPath, makeSlug, repoRoot } from "../src/lib/paths.js";

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
