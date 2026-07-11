import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDataDir, fixtureMeta, seedEntry } from "./helpers.js";
import { designDir } from "../src/lib/paths.js";
import { readMeta, readAnalysis } from "../src/lib/meta.js";
import { openDb, searchDesigns } from "../src/lib/db.js";
import { analyze } from "../src/librarian/analyze.js";

const fakeClaude = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "librarian", "fake-claude.sh");

function seedCaptured() {
  const meta = fixtureMeta({
    status: "needs-analysis", category: "other", tags: [], palette: [],
    components: [
      { type: "other", path: "components/section-0.png", description: "" },
      { type: "other", path: "components/section-1.png", description: "" },
    ],
  });
  seedEntry(meta);
  const dir = designDir(meta.slug);
  fs.mkdirSync(path.join(dir, "components"), { recursive: true });
  fs.writeFileSync(path.join(dir, "components", "section-0.png"), "png0");
  fs.writeFileSync(path.join(dir, "components", "section-1.png"), "png1");
  fs.writeFileSync(path.join(dir, "tokens.json"), JSON.stringify({ declared: {}, empiricalPalette: [] }));
  return meta;
}

beforeEach(() => {
  process.env.GOOD_EYE_CLAUDE_BIN = fakeClaude;
});
afterEach(() => {
  delete process.env.GOOD_EYE_CLAUDE_BIN;
  delete process.env.FAKE_CLAUDE_STATE;
  delete process.env.FAKE_CLAUDE_ALWAYS_BAD;
});

test("analyze applies librarian output, renames crops, promotes status, indexes", async () => {
  tempDataDir();
  const seeded = seedCaptured();
  await analyze(seeded.slug);

  const meta = readMeta(seeded.slug);
  assert.equal(meta.status, "complete");
  assert.equal(meta.category, "saas-landing");
  assert.deepEqual(meta.tags, ["minimal", "airy", "typography-led"]);
  assert.equal(meta.components.find((c) => c.type === "hero")?.path, "components/hero.png");
  assert.equal(meta.components.find((c) => c.type === "pricing")?.path, "components/pricing.png");
  assert.ok(fs.existsSync(path.join(designDir(meta.slug), "components", "hero.png")));
  assert.match(readAnalysis(meta.slug), /restraint/);

  const hits = searchDesigns(openDb(), { query: "restraint" });
  assert.equal(hits[0]?.slug, meta.slug);
});

test("analyze retries once after invalid output and then succeeds", async () => {
  tempDataDir();
  process.env.FAKE_CLAUDE_STATE = path.join(os.tmpdir(), `fake-claude-${Date.now()}`);
  const seeded = seedCaptured();
  await analyze(seeded.slug);
  assert.equal(readMeta(seeded.slug).status, "complete");
});

test("analyze leaves entry needs-analysis after two failures, still indexes", async () => {
  tempDataDir();
  process.env.FAKE_CLAUDE_ALWAYS_BAD = "1";
  const seeded = seedCaptured();
  await analyze(seeded.slug);
  assert.equal(readMeta(seeded.slug).status, "needs-analysis");
  const hits = searchDesigns(openDb(), { query: "example" });
  assert.equal(hits[0]?.slug, seeded.slug);
});

test("partial capture stays partial after successful analysis", async () => {
  tempDataDir();
  const seeded = seedCaptured();
  seedEntry(fixtureMeta({ ...readMeta(seeded.slug), status: "partial" })); // simulate degraded capture
  await analyze(seeded.slug);
  assert.equal(readMeta(seeded.slug).status, "partial");
});
