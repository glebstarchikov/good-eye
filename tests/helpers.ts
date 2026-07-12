import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** Serve tests/fixtures/site on an ephemeral port. */
export async function startFixtureServer(): Promise<{ base: string; close: () => void }> {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "site");
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    // /hang holds the connection open forever, so a page fetching it never reaches
    // networkidle — mirrors analytics-heavy production sites (Stripe et al.).
    if (req.url === "/hang") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("streaming");
      return; // deliberately never res.end()
    }
    const file = path.join(fixtures, req.url === "/" ? "index.html" : req.url!.slice(1));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": file.endsWith(".css") ? "text/css" : "text/html" });
    res.end(fs.readFileSync(file));
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}/`,
    close: () => { for (const s of sockets) s.destroy(); server.close(); }, // destroy the hanging socket so close() returns
  };
}
