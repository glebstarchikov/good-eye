import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Vibrant } from "node-vibrant/node";
import { designDir, ensureDir, makeSlug } from "../lib/paths.js";
import { MetaSchema, writeMeta } from "../lib/meta.js";

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export async function ingestFolder(args: {
  folder: string;
  name: string;
  platform: "ios" | "android" | "macos" | "web";
  note?: string;
}): Promise<string> {
  const files = fs.readdirSync(args.folder).filter((f) => IMAGE_EXT.test(f)).sort();
  if (files.length === 0) throw new Error(`No images (.png/.jpg/.webp) found in ${args.folder}`);

  const slug = makeSlug(args.name);
  const dir = designDir(slug);
  if (fs.existsSync(dir)) throw new Error(`Entry "${slug}" already exists for today`);
  ensureDir(path.join(dir, "screens"));

  const screens = files.map((f, i) => {
    const ext = path.extname(f).toLowerCase().replace("jpeg", "jpg");
    const rel = path.join("screens", `screen-${String(i + 1).padStart(2, "0")}${ext}`);
    fs.copyFileSync(path.join(args.folder, f), path.join(dir, rel));
    return { name: `screen-${i + 1}`, path: rel, description: "" };
  });

  const palette = await Vibrant.from(path.join(dir, screens[0].path)).getPalette();
  const empiricalPalette = Object.entries(palette)
    .filter(([, s]) => s)
    .map(([name, s]) => ({ name, hex: s!.hex, population: s!.population }));
  fs.writeFileSync(path.join(dir, "tokens.json"), JSON.stringify({ declared: {}, empiricalPalette }, null, 2));

  const meta = MetaSchema.parse({
    slug, source_type: "app", platform: args.platform, url: null, domain: args.name,
    title: args.name, category: "other", status: "needs-analysis",
    captured_at: new Date().toISOString(), note: args.note ?? "",
    tags: [], palette: [], typography: {}, components: [], screens,
  });
  writeMeta(meta);
  return slug;
}

export function isStoreUrl(url: string): boolean {
  return /(^|\.)apps\.apple\.com|(^|\.)play\.google\.com/.test(new URL(url).hostname);
}

/** Best-effort per spec §4 — store listing markup changes; folder ingestion is the reliable path. */
export function extractListingImages(html: string): string[] {
  const urls = new Set<string>();
  for (const m of html.matchAll(/https:\/\/[a-z0-9-]+\.mzstatic\.com\/[^"'\s,]+\.(?:png|jpe?g|webp)[^"'\s,]*/gi)) {
    urls.add(m[0]);
  }
  for (const m of html.matchAll(/https:\/\/play-lh\.googleusercontent\.com\/[^"'\s,)]+/gi)) {
    urls.add(m[0]);
  }
  return [...urls].filter((u) => !/icon/i.test(u)).slice(0, 12);
}

export async function ingestAppStore(url: string, note?: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) good-eye/0.1" } });
  if (!res.ok) throw new Error(`Store listing fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const images = extractListingImages(html);
  if (images.length < 2) {
    throw new Error(
      "Could not scrape enough screenshots from the listing. Save screenshots to a folder and ingest with { folder, name, platform } instead."
    );
  }
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const name = (titleMatch?.[1] ?? new URL(url).pathname).split(/[–|-]/)[0].trim().slice(0, 40) || "app";
  const platform = new URL(url).hostname.includes("apple") ? "ios" as const : "android" as const;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "good-eye-store-"));
  // Downloads are copied into the entry by ingestFolder, so the temp dir must never leak.
  try {
    let i = 0;
    for (const imgUrl of images) {
      const r = await fetch(imgUrl, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) good-eye/0.1" } });
      if (!r.ok) continue;
      const ext = imgUrl.match(/\.(png|jpe?g|webp)/i)?.[1] ?? "png";
      fs.writeFileSync(path.join(tmp, `shot-${String(i++).padStart(2, "0")}.${ext.replace("jpeg", "jpg")}`),
        Buffer.from(await r.arrayBuffer()));
    }
    const slug = await ingestFolder({ folder: tmp, name, platform, note });
    // Record the listing URL on the entry (folder ingestion sets url: null).
    const metaPath = path.join(designDir(slug), "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.url = url;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return slug;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
