import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDataDir, fixtureMeta, seedEntry } from "./helpers.js";
import { designDir } from "../src/lib/paths.js";
import { openDb, upsertDesign, searchDesigns, reindexAll, listTagCounts } from "../src/lib/db.js";

function seedThree() {
  const a = fixtureMeta(); // example-com, saas-landing, tags minimal+airy, hero component
  const b = fixtureMeta({
    slug: "darkco-com--2026-02-01", domain: "darkco.com", title: "DarkCo — analytics",
    category: "dashboard", tags: ["dark-mode", "dense"], captured_at: "2026-02-01T00:00:00.000Z",
    components: [{ type: "pricing", path: "components/pricing.png", description: "3-tier pricing table" }],
  });
  const c = fixtureMeta({
    slug: "fitapp--2026-03-01", source_type: "app", platform: "ios", url: null,
    domain: "FitApp", title: "FitApp", category: "mobile-app", tags: ["playful", "vibrant"],
    captured_at: "2026-03-01T00:00:00.000Z", components: [],
    screens: [{ name: "onboarding", path: "screens/screen-01.png", description: "warm onboarding" }],
  });
  seedEntry(a, "Minimal SaaS landing with generous whitespace.");
  seedEntry(b, "Dense dark dashboard with a strong pricing page.");
  seedEntry(c, "Playful fitness onboarding.");
  return { a, b, c };
}

test("upsert + FTS search + filters", () => {
  tempDataDir();
  const db = openDb();
  const { b } = seedThree();
  assert.equal(reindexAll(db), 3);

  const pricing = searchDesigns(db, { query: "pricing" });
  assert.ok(pricing.some((h) => h.slug === b.slug));

  const apps = searchDesigns(db, { source_type: "app" });
  assert.equal(apps.length, 1);
  assert.equal(apps[0].slug, "fitapp--2026-03-01");

  const darkDense = searchDesigns(db, { tags: ["dark-mode", "dense"] });
  assert.deepEqual(darkDense.map((h) => h.slug), [b.slug]);

  assert.equal(searchDesigns(db, { tags: ["dark-mode", "playful"] }).length, 0); // AND semantics

  const noQuery = searchDesigns(db, {});
  assert.equal(noQuery[0].slug, "fitapp--2026-03-01"); // newest first
});

test("upsert is idempotent per slug", () => {
  tempDataDir();
  const db = openDb();
  const meta = fixtureMeta();
  seedEntry(meta, "review");
  upsertDesign(db, meta, "review");
  upsertDesign(db, { ...meta, title: "Example v2" }, "review");
  const hits = searchDesigns(db, { query: "example" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "Example v2");
});

test("search survives punctuation-laden queries", () => {
  tempDataDir();
  const db = openDb();
  seedThree();
  reindexAll(db);
  assert.doesNotThrow(() => searchDesigns(db, { query: 'dark "AND* (pricing:' }));
});

test("reindexAll is atomic: a corrupt meta.json aborts the rebuild without wiping the catalog", () => {
  tempDataDir();
  const db = openDb();
  const a = fixtureMeta();
  const b = fixtureMeta({
    slug: "darkco-com--2026-02-01", domain: "darkco.com", title: "DarkCo — analytics",
    category: "dashboard", tags: ["dark-mode", "dense"], captured_at: "2026-02-01T00:00:00.000Z",
  });
  seedEntry(a, "Minimal SaaS landing.");
  seedEntry(b, "Dense dark dashboard.");
  assert.equal(reindexAll(db), 2);

  // Corrupt one meta.json on disk, then attempt a second reindex.
  fs.writeFileSync(path.join(designDir(b.slug), "meta.json"), "{not json");
  assert.throws(() => reindexAll(db));

  // The catalog must still hold both entries from the first successful reindex.
  const slugs = searchDesigns(db, {}).map((h) => h.slug).sort();
  assert.deepEqual(slugs, [b.slug, a.slug].sort());
});

test("listTagCounts aggregates", () => {
  tempDataDir();
  const db = openDb();
  seedThree();
  reindexAll(db);
  const counts = Object.fromEntries(listTagCounts(db).map((t) => [t.tag, t.count]));
  assert.equal(counts["minimal"], 1);
  assert.equal(counts["dark-mode"], 1);
});
