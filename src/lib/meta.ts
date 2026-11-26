import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { designDir, designsDir } from "./paths.js";
import { CATEGORIES } from "./vocab.js";

const PaletteEntry = z.object({
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  role: z.enum(["primary", "accent", "background", "surface", "text"]),
  prominence: z.number().min(0).max(1),
});

const Typography = z.object({
  families: z.array(z.string()).default([]),
  scale: z.string().default(""),
  notes: z.string().default(""),
});

export const MetaSchema = z.object({
  slug: z.string(),
  source_type: z.enum(["web", "app"]),
  platform: z.enum(["web", "ios", "android", "macos"]),
  url: z.string().nullable(),
  domain: z.string(), // hostname for web, app name for apps
  title: z.string().default(""),
  category: z.enum(CATEGORIES).default("other"),
  status: z.enum(["complete", "partial", "needs-analysis"]),
  captured_at: z.string(),
  note: z.string().default(""),
  tags: z.array(z.string()).default([]),
  palette: z.array(PaletteEntry).default([]),
  typography: Typography.prefault({}),
  components: z.array(z.object({ type: z.string(), path: z.string(), description: z.string() })).default([]),
  screens: z.array(z.object({ name: z.string(), path: z.string(), description: z.string() })).default([]),
});
export type Meta = z.infer<typeof MetaSchema>;

/** What the librarian (claude -p) must return. `file` refers to an existing provisional image path. */
export const LibrarianOutputSchema = z.object({
  category: z.enum(CATEGORIES),
  tags: z.array(z.string()).min(1).max(10),
  palette: z.array(PaletteEntry).min(1).max(8),
  typography: Typography,
  components: z.array(z.object({ file: z.string(), type: z.string(), description: z.string() })).default([]),
  screens: z.array(z.object({ file: z.string(), name: z.string(), description: z.string() })).default([]),
  review: z.string().min(100),
});
export type LibrarianOutput = z.infer<typeof LibrarianOutputSchema>;

// The optional dir is for a forced re-capture, built in staging under the entry's final slug.
export function readMeta(slug: string, dir: string = designDir(slug)): Meta {
  const p = path.join(dir, "meta.json");
  if (!fs.existsSync(p)) throw new Error(`No design entry "${slug}" (missing ${p})`);
  return MetaSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
}

export function writeMeta(meta: Meta, dir: string = designDir(meta.slug)): void {
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

export function listSlugs(): string[] {
  if (!fs.existsSync(designsDir())) return [];
  return fs.readdirSync(designsDir())
    .filter((d) => fs.existsSync(path.join(designsDir(), d, "meta.json")))
    .sort();
}

export function readAnalysis(slug: string, dir: string = designDir(slug)): string {
  const p = path.join(dir, "analysis.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

export function writeAnalysis(slug: string, text: string, dir: string = designDir(slug)): void {
  fs.writeFileSync(path.join(dir, "analysis.md"), text);
}

export function domainFromUrl(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}
