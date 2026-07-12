import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDataDir, startFixtureServer } from "./helpers.js";
import { designDir } from "../src/lib/paths.js";
import { readMeta } from "../src/lib/meta.js";
import { captureWeb, salvageOrCleanup } from "../src/capture/web.js";

let base: string;
let close: () => void;

before(async () => { ({ base, close } = await startFixtureServer()); });
after(() => close());

test("captureWeb produces artifacts, tokens, and provisional meta", async () => {
  tempDataDir();
  const slug = await captureWeb(base, { note: "fixture run" });
  const dir = designDir(slug);

  for (const f of ["desktop.png", "desktop-fold.png", "mobile.png", "page.html", "styles.css", "tokens.json", "meta.json"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `missing ${f}`);
  }
  assert.ok(fs.statSync(path.join(dir, "desktop.png")).size > 1000);

  const tokens = JSON.parse(fs.readFileSync(path.join(dir, "tokens.json"), "utf8"));
  assert.equal(tokens.declared.cssVars["--brand"], "#635bff");
  assert.ok(tokens.declared.fonts.some((f: string) => /georgia/i.test(f)));
  assert.ok(tokens.empiricalPalette.length >= 1);

  const meta = readMeta(slug);
  assert.equal(meta.source_type, "web");
  assert.equal(meta.status, "needs-analysis");
  assert.equal(meta.note, "fixture run");
  assert.ok(meta.title.includes("FixtureCo"));
  assert.ok(meta.components.length >= 4, `expected >=4 section crops, got ${meta.components.length}`);
  for (const c of meta.components) {
    assert.equal(c.type, "other");
    assert.ok(fs.existsSync(path.join(dir, c.path)), `missing crop ${c.path}`);
  }
});

test("same-day duplicate is refused without force, allowed with force", async () => {
  tempDataDir();
  const slug = await captureWeb(base);
  await assert.rejects(() => captureWeb(base), /already exists/);
  const again = await captureWeb(base, { force: true });
  assert.equal(again, slug);
});

test("hard load failure creates no entry", async () => {
  const tmp = tempDataDir();
  await assert.rejects(() => captureWeb(`${base}missing-page`), /HTTP 404/);
  assert.ok(!fs.existsSync(path.join(tmp, "designs")) || fs.readdirSync(path.join(tmp, "designs")).length === 0);
});

test("salvageOrCleanup writes a provisional partial meta when a screenshot exists", () => {
  tempDataDir();
  const slug = "salvage-me--2026-01-01";
  const dir = designDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "desktop-fold.png"), "fake-png-bytes");

  const salvaged = salvageOrCleanup(dir, { slug, url: "https://example.com", domain: "example.com", note: "" });

  assert.equal(salvaged, true);
  assert.ok(fs.existsSync(path.join(dir, "meta.json")));
  const meta = readMeta(slug);
  assert.equal(meta.status, "partial");
});

test("salvageOrCleanup removes the dir when nothing was captured", () => {
  tempDataDir();
  const slug = "nothing-here--2026-01-01";
  const dir = designDir(slug);
  fs.mkdirSync(dir, { recursive: true });

  const salvaged = salvageOrCleanup(dir, { slug, url: "https://example.com", domain: "example.com", note: "" });

  assert.equal(salvaged, false);
  assert.ok(!fs.existsSync(dir));
});

test("a never-idle page still captures clean, not partial (networkidle timeout is not a degrade)", async () => {
  tempDataDir();
  const slug = await captureWeb(`${base}busy.html`, { note: "busy" });
  const meta = readMeta(slug);
  assert.equal(meta.status, "needs-analysis", "networkidle timeout alone must not mark the entry partial");
  assert.ok(fs.existsSync(path.join(designDir(slug), "desktop.png")));
});
