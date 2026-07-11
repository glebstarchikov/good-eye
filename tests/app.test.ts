import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { tempDataDir } from "./helpers.js";
import { designDir } from "../src/lib/paths.js";
import { readMeta } from "../src/lib/meta.js";
import { ingestFolder, extractListingImages, isStoreUrl, ingestAppStore } from "../src/capture/app.js";

async function screenshotFolder(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shots-"));
  for (const [i, color] of [[1, 200], [2, 60]] as const) {
    await sharp({ create: { width: 390, height: 844, channels: 3, background: { r: color, g: 80, b: 255 } } })
      .png().toFile(path.join(dir, `IMG_000${i}.png`));
  }
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an image");
  return dir;
}

test("ingestFolder copies screens, extracts palette, writes provisional meta", async () => {
  tempDataDir();
  const folder = await screenshotFolder();
  const slug = await ingestFolder({ folder, name: "Fit App", platform: "ios", note: "great onboarding" });
  const meta = readMeta(slug);
  assert.equal(meta.source_type, "app");
  assert.equal(meta.platform, "ios");
  assert.equal(meta.status, "needs-analysis");
  assert.equal(meta.url, null);
  assert.equal(meta.screens.length, 2);
  assert.equal(meta.screens[0].path, "screens/screen-01.png");
  assert.ok(fs.existsSync(path.join(designDir(slug), "screens", "screen-01.png")));
  const tokens = JSON.parse(fs.readFileSync(path.join(designDir(slug), "tokens.json"), "utf8"));
  assert.ok(tokens.empiricalPalette.length >= 1);
});

test("ingestFolder rejects an imageless folder", async () => {
  tempDataDir();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "empty-"));
  await assert.rejects(
    () => ingestFolder({ folder: empty, name: "X", platform: "ios" }),
    /no images/i
  );
});

test("extractListingImages finds store screenshots, skips icons", () => {
  const html = `
    <img src="https://is1-ssl.mzstatic.com/image/thumb/PurpleSource/v4/ab/cd/screen1/392x696bb.png 2x">
    <source srcset="https://is2-ssl.mzstatic.com/image/thumb/PurpleSource/v4/ef/gh/screen2/300x0w.webp">
    <img src="https://is3-ssl.mzstatic.com/image/thumb/AppIcon-abc/icon-540x540.png">
    <img data-src="https://play-lh.googleusercontent.com/abcdef=w2560-h1440">
  `;
  const urls = extractListingImages(html);
  assert.equal(urls.length, 3);
  assert.ok(urls.every((u) => !/icon/i.test(u)));
});

test("isStoreUrl", () => {
  assert.equal(isStoreUrl("https://apps.apple.com/us/app/things-3/id904237743"), true);
  assert.equal(isStoreUrl("https://play.google.com/store/apps/details?id=com.x"), true);
  assert.equal(isStoreUrl("https://stripe.com"), false);
});

test("ingestAppStore ingests listing screenshots and cleans up its temp dir", async () => {
  tempDataDir();
  const listingUrl = "https://apps.apple.com/us/app/x/id1";
  const listingHtml = `
    <title>Fit Track - App Store</title>
    <img src="https://is1-ssl.mzstatic.com/image/thumb/PurpleSource/v4/ab/cd/screen1/392x696bb.png">
    <img src="https://is2-ssl.mzstatic.com/image/thumb/PurpleSource/v4/ef/gh/screen2/392x696bb.png">
  `;
  const pngBytes = await sharp({ create: { width: 390, height: 844, channels: 3, background: { r: 120, g: 80, b: 255 } } })
    .png().toBuffer();

  const tmpDirsBefore = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("good-eye-store-")));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const target = String(input);
    if (target === listingUrl) return new Response(listingHtml, { status: 200 });
    return new Response(pngBytes, { status: 200 });
  }) as typeof fetch;
  try {
    const slug = await ingestAppStore(listingUrl, "clean layout");
    const meta = readMeta(slug);
    assert.equal(meta.url, listingUrl);
    assert.equal(meta.screens.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }

  // The mkdtemp dir must be removed on success (and failure) — no leaks in os.tmpdir().
  const tmpDirsAfter = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("good-eye-store-")));
  assert.deepEqual(tmpDirsAfter, tmpDirsBefore);
});
