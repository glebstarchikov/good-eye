import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import sharp from "sharp";
import { tempDataDir, fixtureMeta, seedEntry } from "./helpers.js";
import { designDir, ensureDir } from "../src/lib/paths.js";
import { thumbnailSource, jpegBase64, imageBlock } from "../src/lib/images.js";

async function makePng(p: string, width = 1600, height = 1000) {
  ensureDir(path.dirname(p));
  await sharp({ create: { width, height, channels: 3, background: { r: 99, g: 91, b: 255 } } })
    .png().toFile(p);
}

test("jpegBase64 resizes within bounds and defaults to 768 wide", async () => {
  const tmp = tempDataDir();
  const src = path.join(tmp, "big.png");
  await makePng(src);
  const { data, mimeType } = await jpegBase64(src);
  assert.equal(mimeType, "image/jpeg");
  const buf = Buffer.from(data, "base64");
  const info = await sharp(buf).metadata();
  assert.equal(info.width, 768);
  const tall = await jpegBase64(src, { maxHeight: 500 });
  const tallInfo = await sharp(Buffer.from(tall.data, "base64")).metadata();
  assert.equal(tallInfo.height, 500);
});

test("thumbnailSource picks fold for web, first screen for app, null when missing", async () => {
  tempDataDir();
  const web = fixtureMeta();
  seedEntry(web);
  await makePng(path.join(designDir(web.slug), "desktop-fold.png"), 400, 300);
  assert.ok(thumbnailSource(web)!.endsWith("desktop-fold.png"));

  const app = fixtureMeta({
    slug: "fitapp--2026-03-01", source_type: "app", platform: "ios", url: null, domain: "FitApp",
    components: [], screens: [{ name: "home", path: "screens/screen-01.png", description: "" }],
  });
  seedEntry(app);
  await makePng(path.join(designDir(app.slug), "screens", "screen-01.png"), 400, 800);
  assert.ok(thumbnailSource(app)!.endsWith("screen-01.png"));

  const bare = fixtureMeta({ slug: "bare-com--2026-01-02", domain: "bare.com" });
  seedEntry(bare); // no images on disk
  assert.equal(thumbnailSource(bare), null);
});

test("imageBlock returns an MCP-shaped block", async () => {
  const tmp = tempDataDir();
  const src = path.join(tmp, "x.png");
  await makePng(src, 300, 200);
  const block = await imageBlock(src);
  assert.equal(block.type, "image");
  assert.equal(block.mimeType, "image/jpeg");
  assert.ok(block.data.length > 100);
});
