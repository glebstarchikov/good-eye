import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDataDir, fixtureMeta, seedEntry } from "./helpers.js";
import { readMeta, writeMeta, listSlugs, readAnalysis, domainFromUrl, LibrarianOutputSchema } from "../src/lib/meta.js";

test("writeMeta/readMeta round-trip", () => {
  tempDataDir();
  const meta = fixtureMeta();
  seedEntry(meta, "A fine review.");
  assert.deepEqual(readMeta(meta.slug), meta);
  assert.equal(readAnalysis(meta.slug), "A fine review.");
  assert.deepEqual(listSlugs(), [meta.slug]);
});

test("readMeta throws a clear error for unknown slug", () => {
  tempDataDir();
  assert.throws(() => readMeta("nope--2026-01-01"), /No design entry/);
});

test("readAnalysis returns empty string when missing", () => {
  tempDataDir();
  const meta = fixtureMeta();
  seedEntry(meta); // no analysis
  assert.equal(readAnalysis(meta.slug), "");
});

test("domainFromUrl strips www", () => {
  assert.equal(domainFromUrl("https://www.stripe.com/pricing"), "stripe.com");
});

test("LibrarianOutputSchema rejects unknown category, accepts valid output", () => {
  const good = {
    category: "saas-landing",
    tags: ["minimal", "airy"],
    palette: [{ hex: "#635BFF", role: "primary", prominence: 0.2 }],
    typography: { families: ["Inter"], scale: "16/24/40", notes: "weight-driven" },
    components: [{ file: "components/section-0.png", type: "hero", description: "big hero" }],
    screens: [],
    review: "x".repeat(120),
  };
  assert.equal(LibrarianOutputSchema.safeParse(good).success, true);
  assert.equal(LibrarianOutputSchema.safeParse({ ...good, category: "vibes" }).success, false);
  assert.equal(LibrarianOutputSchema.safeParse({ ...good, review: "too short" }).success, false);
});
