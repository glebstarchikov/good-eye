import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { designDir } from "./paths.js";
import type { Meta } from "./meta.js";

/** Canonical thumbnail per spec §4: web → desktop-fold.png, app → first screen. */
export function thumbnailSource(meta: Meta): string | null {
  const dir = designDir(meta.slug);
  const rel = meta.source_type === "web" ? "desktop-fold.png" : meta.screens[0]?.path;
  if (!rel) return null;
  const abs = path.join(dir, rel);
  return fs.existsSync(abs) ? abs : null;
}

export async function jpegBase64(
  imagePath: string,
  opts: { maxWidth?: number; maxHeight?: number } = {}
): Promise<{ data: string; mimeType: "image/jpeg" }> {
  const width = opts.maxWidth ?? (opts.maxHeight ? undefined : 768);
  const buf = await sharp(imagePath)
    .resize({ width, height: opts.maxHeight, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { data: buf.toString("base64"), mimeType: "image/jpeg" };
}

export async function imageBlock(
  imagePath: string,
  opts: { maxWidth?: number; maxHeight?: number } = {}
): Promise<{ type: "image"; data: string; mimeType: "image/jpeg" }> {
  return { type: "image", ...(await jpegBase64(imagePath, opts)) };
}
