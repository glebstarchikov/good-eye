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
  delete process.env.FAKE_CLAUDE_FENCED;
  delete process.env.FAKE_CLAUDE_OUTPUT;
});

const goodOutput = JSON.parse(fs.readFileSync(path.join(path.dirname(fakeClaude), "good.json"), "utf8"));

/** Make the fake librarian answer with good.json, its item lists swapped for these. */
function librarianSays(items: { components?: unknown[]; screens?: unknown[] }) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-out-")), "out.json");
  fs.writeFileSync(file, JSON.stringify({ ...goodOutput, ...items }));
  process.env.FAKE_CLAUDE_OUTPUT = file;
}

function seedApp() {
  const meta = fixtureMeta({
    slug: "fit-app--2026-01-01", source_type: "app", platform: "ios", url: null, domain: "",
    status: "needs-analysis", category: "other", tags: [], palette: [], components: [],
    screens: [
      { name: "screen-01", path: "screens/screen-01.png", description: "" },
      { name: "screen-02", path: "screens/screen-02.png", description: "" },
    ],
  });
  seedEntry(meta);
  const dir = designDir(meta.slug);
  fs.mkdirSync(path.join(dir, "screens"), { recursive: true });
  fs.writeFileSync(path.join(dir, "screens", "screen-01.png"), "s1");
  fs.writeFileSync(path.join(dir, "screens", "screen-02.png"), "s2");
  return meta;
}

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

test("analyze succeeds when the librarian output is fence-wrapped with surrounding prose", async () => {
  tempDataDir();
  process.env.FAKE_CLAUDE_FENCED = "1";
  const seeded = seedCaptured();
  await analyze(seeded.slug);

  const meta = readMeta(seeded.slug);
  assert.equal(meta.status, "complete");
  assert.equal(meta.category, "saas-landing");
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

test("partial entry that double-fails stays partial and logs to stderr", async () => {
  tempDataDir();
  process.env.FAKE_CLAUDE_ALWAYS_BAD = "1";
  const seeded = seedCaptured();
  seedEntry(fixtureMeta({ ...readMeta(seeded.slug), status: "partial" })); // simulate degraded capture
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    await analyze(seeded.slug);
  } finally {
    console.error = realError;
  }
  assert.equal(readMeta(seeded.slug).status, "partial");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /analysis failed .* status left as partial/);
});

test("partial capture stays partial after successful analysis", async () => {
  tempDataDir();
  const seeded = seedCaptured();
  seedEntry(fixtureMeta({ ...readMeta(seeded.slug), status: "partial" })); // simulate degraded capture
  await analyze(seeded.slug);
  assert.equal(readMeta(seeded.slug).status, "partial");
});

// The prompt hands the librarian absolute paths (so it can Read them), and it echoes them back.
test("analyze applies crops the librarian names by absolute path", async () => {
  tempDataDir();
  const seeded = seedCaptured();
  const dir = designDir(seeded.slug);
  librarianSays({
    components: goodOutput.components.map((c: { file: string }) => ({ ...c, file: path.join(dir, c.file) })),
  });
  await analyze(seeded.slug);

  const meta = readMeta(seeded.slug);
  assert.deepEqual(meta.components.map((c) => c.path).sort(), ["components/hero.png", "components/pricing.png"]);
  assert.ok(meta.components.every((c) => c.description));
  assert.ok(fs.existsSync(path.join(dir, "components", "hero.png")));
});

test("analyze names app screens given by absolute path, and never deletes a screen it skipped", async () => {
  tempDataDir();
  const seeded = seedApp();
  const dir = designDir(seeded.slug);
  librarianSays({
    components: [],
    screens: [{ file: path.join(dir, "screens/screen-01.png"), name: "onboarding", description: "a welcome card" }],
  });
  await analyze(seeded.slug);

  const meta = readMeta(seeded.slug);
  assert.equal(meta.screens[0].name, "onboarding");
  assert.equal(meta.screens[0].description, "a welcome card");
  assert.equal(meta.screens.length, 2); // the user's own screenshots are never pruned
  assert.ok(fs.existsSync(path.join(dir, "screens", "screen-02.png")));
});

test("analyze drops the crops the librarian left out", async () => {
  tempDataDir();
  const seeded = seedCaptured();
  librarianSays({ components: [goodOutput.components[0]] }); // claims section-0 only
  await analyze(seeded.slug);

  const meta = readMeta(seeded.slug);
  assert.deepEqual(meta.components.map((c) => c.path), ["components/hero.png"]);
  assert.ok(!fs.existsSync(path.join(designDir(seeded.slug), "components", "section-1.png")));
});

test("a librarian path outside the entry matches nothing, so nothing moves or is deleted", async () => {
  tempDataDir();
  const seeded = seedCaptured();
  const dir = designDir(seeded.slug);
  // A sibling entry holding a file at the same relative path: the shape a resolved `../` would hit.
  const sibling = designDir("other-com--2026-01-01");
  fs.mkdirSync(path.join(sibling, "components"), { recursive: true });
  fs.writeFileSync(path.join(sibling, "components", "section-0.png"), "theirs");
  librarianSays({
    components: [
      { file: path.join(sibling, "components/section-0.png"), type: "hero", description: "x" },
      { file: "../other-com--2026-01-01/components/section-0.png", type: "pricing", description: "y" },
    ],
  });
  await analyze(seeded.slug);

  assert.equal(fs.readFileSync(path.join(sibling, "components", "section-0.png"), "utf8"), "theirs");
  const meta = readMeta(seeded.slug);
  // No crop was claimed, so none is pruned: a librarian that misreads every path must not wipe the entry.
  assert.deepEqual(meta.components.map((c) => c.path), ["components/section-0.png", "components/section-1.png"]);
  assert.ok(meta.components.every((c) => c.type === "other"));
  assert.ok(fs.existsSync(path.join(dir, "components", "section-0.png")));
  assert.ok(fs.existsSync(path.join(dir, "components", "section-1.png")));
});

test("re-analysis: a kept crop renamed onto a dropped crop's name survives the prune", async () => {
  tempDataDir();
  const seeded = seedCaptured();
  const dir = designDir(seeded.slug);
  // A previous analysis left section-0 as hero.png; this one drops it and calls section-1 the hero.
  fs.renameSync(path.join(dir, "components", "section-0.png"), path.join(dir, "components", "hero.png"));
  seedEntry(fixtureMeta({
    ...readMeta(seeded.slug),
    components: [
      { type: "hero", path: "components/hero.png", description: "old hero" },
      { type: "other", path: "components/section-1.png", description: "" },
    ],
  }));
  librarianSays({ components: [{ file: "components/section-1.png", type: "hero", description: "new hero" }] });
  await analyze(seeded.slug);

  const meta = readMeta(seeded.slug);
  assert.deepEqual(meta.components, [{ type: "hero", path: "components/hero.png", description: "new hero" }]);
  assert.equal(fs.readFileSync(path.join(dir, "components", "hero.png"), "utf8"), "png1");
});

/** An entry a previous analysis already named: each crop at its typed path, holding `content`. */
function seedAnalyzed(crops: { path: string; type: string; content: string }[]) {
  const seeded = seedCaptured();
  const dir = designDir(seeded.slug);
  for (const f of ["section-0.png", "section-1.png"]) fs.rmSync(path.join(dir, "components", f));
  for (const c of crops) fs.writeFileSync(path.join(dir, c.path), c.content);
  seedEntry(fixtureMeta({
    ...readMeta(seeded.slug), status: "complete",
    components: crops.map((c) => ({ type: c.type, path: c.path, description: `old ${c.type}` })),
  }));
  return { slug: seeded.slug, dir };
}

/** Every file in the entry's components folder, by path, with its content. */
function cropFiles(dir: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(path.join(dir, "components")).sort()
    .map((f) => [`components/${f}`, fs.readFileSync(path.join(dir, "components", f), "utf8")]));
}

test("re-analysis: two crops that swap labels both survive, each with its new label", async () => {
  tempDataDir();
  const { slug, dir } = seedAnalyzed([
    { path: "components/hero.png", type: "hero", content: "was-hero" },
    { path: "components/pricing.png", type: "pricing", content: "was-pricing" },
  ]);
  librarianSays({ components: [
    { file: "components/pricing.png", type: "hero", description: "the old pricing crop is the hero" },
    { file: "components/hero.png", type: "pricing", description: "the old hero crop is pricing" },
  ] });
  await analyze(slug);

  assert.deepEqual(readMeta(slug).components, [
    { type: "pricing", path: "components/pricing.png", description: "the old hero crop is pricing" },
    { type: "hero", path: "components/hero.png", description: "the old pricing crop is the hero" },
  ]);
  assert.deepEqual(cropFiles(dir), { "components/hero.png": "was-pricing", "components/pricing.png": "was-hero" });
});

test("re-analysis: two crops of one type listed in the other order both survive", async () => {
  tempDataDir();
  const { slug, dir } = seedAnalyzed([
    { path: "components/hero.png", type: "hero", content: "first-hero" },
    { path: "components/hero-2.png", type: "hero", content: "second-hero" },
  ]);
  librarianSays({ components: [
    { file: "components/hero-2.png", type: "hero", description: "now the main hero" },
    { file: "components/hero.png", type: "hero", description: "now the alternate hero" },
  ] });
  await analyze(slug);

  assert.deepEqual(readMeta(slug).components, [
    { type: "hero", path: "components/hero-2.png", description: "now the alternate hero" },
    { type: "hero", path: "components/hero.png", description: "now the main hero" },
  ]);
  assert.deepEqual(cropFiles(dir), { "components/hero-2.png": "first-hero", "components/hero.png": "second-hero" });
});

test("re-analysis: a crop the librarian lists twice keeps its first label and its file", async () => {
  tempDataDir();
  const { slug, dir } = seedAnalyzed([
    { path: "components/hero.png", type: "hero", content: "the-crop" },
    { path: "components/cta.png", type: "cta", content: "dropped" },
  ]);
  librarianSays({ components: [
    { file: "components/hero.png", type: "features", description: "first claim" },
    { file: "components/hero.png", type: "pricing", description: "second claim" },
  ] });
  await analyze(slug);

  assert.equal(readMeta(slug).status, "complete");
  assert.deepEqual(readMeta(slug).components, [
    { type: "features", path: "components/features.png", description: "first claim" },
  ]);
  assert.deepEqual(cropFiles(dir), { "components/features.png": "the-crop" });
});

test("re-analysis that keeps every label leaves each crop where it was, and no staging folder behind", async () => {
  tempDataDir();
  const { slug, dir } = seedAnalyzed([
    { path: "components/hero.png", type: "hero", content: "h" },
    { path: "components/pricing.png", type: "pricing", content: "p" },
  ]);
  librarianSays({ components: [
    { file: "components/hero.png", type: "hero", description: "same hero" },
    { file: "components/pricing.png", type: "pricing", description: "same pricing" },
  ] });
  await analyze(slug);

  assert.deepEqual(readMeta(slug).components.map((c) => [c.path, c.description]), [
    ["components/hero.png", "same hero"], ["components/pricing.png", "same pricing"],
  ]);
  assert.deepEqual(cropFiles(dir), { "components/hero.png": "h", "components/pricing.png": "p" });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(".relabel-")), []);
});
