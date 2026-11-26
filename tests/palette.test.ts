import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { extractPalette } from "../src/capture/palette.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "palette-"));

async function solid(name: string, width: number, height: number, background: string, format: "png" | "webp", grey = false) {
  const file = path.join(dir, name);
  let img = sharp({ create: { width, height, channels: 3, background } });
  if (grey) img = img.toColourspace("b-w");
  await img.toFormat(format).toFile(file);
  return file;
}

const hexes = (palette: Awaited<ReturnType<typeof extractPalette>>) =>
  Object.fromEntries(palette.map((s) => [s.name, s.hex]));

// Expected swatches are what node-vibrant (jimp) gave for the same images before the swap to sharp.
test("extractPalette gives node-vibrant's swatches for a solid colour", async () => {
  const palette = await extractPalette(await solid("pink.png", 1, 1, "#ff3366", "png"));
  assert.deepEqual(hexes(palette), {
    Vibrant: "#fc3464", DarkVibrant: "#820120", LightVibrant: "#fd7c9b",
    Muted: "#960225", DarkMuted: "#960225", LightMuted: "#960225",
  });
});

test("extractPalette reads a greyscale image as RGB", async () => {
  const palette = await extractPalette(await solid("grey.png", 200, 100, "#777777", "png", true));
  assert.deepEqual(hexes(palette), { Muted: "#747474" });
});

test("extractPalette leaves out white and transparent pixels", async () => {
  assert.deepEqual(await extractPalette(await solid("white.png", 200, 100, "#ffffff", "png")), []);
  const clear = path.join(dir, "clear.png");
  await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(clear);
  assert.deepEqual(await extractPalette(clear), []);
});

test("extractPalette reads webp, which node-vibrant's jimp could not", async () => {
  const palette = await extractPalette(await solid("blue.webp", 300, 200, "#2244cc", "webp"));
  assert.ok(hexes(palette).Vibrant);
});
