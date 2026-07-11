import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { designDir, ensureDir } from "../src/lib/paths.js";
import { writeMeta, writeAnalysis, MetaSchema, type Meta } from "../src/lib/meta.js";

/** Point GOOD_EYE_DATA_DIR at a fresh temp dir; returns it. Call first in every data-touching test. */
export function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "good-eye-test-"));
  process.env.GOOD_EYE_DATA_DIR = dir;
  return dir;
}

export function fixtureMeta(overrides: Partial<Meta> = {}): Meta {
  return MetaSchema.parse({
    slug: "example-com--2026-01-01",
    source_type: "web",
    platform: "web",
    url: "https://example.com",
    domain: "example.com",
    title: "Example — a fine site",
    category: "saas-landing",
    status: "complete",
    captured_at: "2026-01-01T00:00:00.000Z",
    note: "",
    tags: ["minimal", "airy"],
    palette: [{ hex: "#635BFF", role: "primary", prominence: 0.2 }],
    typography: { families: ["Inter"], scale: "16/24/40", notes: "" },
    components: [{ type: "hero", path: "components/hero.png", description: "big hero" }],
    screens: [],
    ...overrides,
  });
}

export function seedEntry(meta: Meta, analysis?: string): void {
  ensureDir(designDir(meta.slug));
  writeMeta(meta);
  if (analysis !== undefined) writeAnalysis(meta.slug, analysis);
}
