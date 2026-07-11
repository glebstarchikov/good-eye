import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { designDir } from "./lib/paths.js";
import { readAnalysis, readMeta, type Meta } from "./lib/meta.js";
import { openDb, reindexAll, searchDesigns, listTagCounts, type SearchHit } from "./lib/db.js";
import { imageBlock, thumbnailSource } from "./lib/images.js";
import { STYLE_TAGS, CATEGORIES, COMPONENT_TYPES } from "./lib/vocab.js";
import { captureWeb } from "./capture/web.js";
import { ingestAppStore, ingestFolder, isStoreUrl } from "./capture/app.js";
import { analyze } from "./librarian/analyze.js";

type Block =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/jpeg" };
type ToolResult = { content: Block[]; isError?: boolean };

const server = new McpServer({ name: "good-eye", version: "0.1.0" });

function ok(content: Block[]): ToolResult {
  return { content: content.length ? content : [{ type: "text", text: "No matches." }] };
}
function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

function hitText(h: SearchHit): string {
  return [
    `## ${h.slug}`,
    `${h.title} — ${h.domain} | ${h.category} | ${h.source_type} | ${h.status}`,
    h.tags.length ? `tags: ${h.tags.join(", ")}` : "",
    h.note ? `note: ${h.note}` : "",
    h.snippet ? `match: ${h.snippet}` : "",
  ].filter(Boolean).join("\n");
}

function metaText(meta: Meta, analysis: string): string {
  const palette = meta.palette.map((p) => `${p.hex} (${p.role})`).join(", ");
  const items = meta.source_type === "web"
    ? meta.components.map((c) => `- ${c.type}: ${c.description} (${c.path})`)
    : meta.screens.map((s) => `- ${s.name}: ${s.description} (${s.path})`);
  return [
    `# ${meta.slug}`,
    `${meta.title} — ${meta.url ?? meta.domain}`,
    `category: ${meta.category} | platform: ${meta.platform} | status: ${meta.status} | captured: ${meta.captured_at}`,
    `tags: ${meta.tags.join(", ")}`,
    `palette: ${palette}`,
    `typography: ${meta.typography.families.join(", ")} — ${meta.typography.scale} ${meta.typography.notes}`,
    meta.note ? `curator note: ${meta.note}` : "",
    "", items.join("\n"), "", "## Review", analysis || "(not yet analyzed)",
  ].filter((l) => l !== "").join("\n");
}

server.registerTool("search_designs", {
  description:
    "Search the personal design inspiration library (websites + apps). Returns ranked matches with metadata and thumbnail images. Use before proposing any visual design.",
  inputSchema: {
    query: z.string().optional().describe("Free text: matched against titles, tags, analyses, component descriptions"),
    tags: z.array(z.string()).optional().describe("Style tags, AND semantics — see list_tags"),
    category: z.string().optional(),
    source_type: z.enum(["web", "app"]).optional(),
    limit: z.number().int().min(1).max(20).default(5),
  },
}, async (args) => {
  try {
    const db = openDb();
    const hits = searchDesigns(db, args);
    db.close();
    const content: Block[] = [];
    for (const h of hits) {
      content.push({ type: "text", text: hitText(h) });
      const src = thumbnailSource(readMeta(h.slug));
      if (src) content.push(await imageBlock(src, { maxWidth: 768 }));
    }
    return ok(content);
  } catch (err) { return fail(err); }
});

server.registerTool("get_design", {
  description: "Full detail for one library entry: metadata, palette, typography, written design review, and images.",
  inputSchema: {
    slug: z.string(),
    images: z.enum(["fold", "full", "components", "none"]).default("fold"),
  },
}, async ({ slug, images }) => {
  try {
    const meta = readMeta(slug);
    const dir = designDir(slug);
    const content: Block[] = [{ type: "text", text: metaText(meta, readAnalysis(slug)) }];
    if (images === "fold") {
      const src = thumbnailSource(meta);
      if (src) content.push(await imageBlock(src, { maxWidth: 1000 }));
    } else if (images === "full") {
      if (meta.source_type === "web") {
        for (const f of ["desktop.png", "mobile.png"]) {
          content.push(await imageBlock(path.join(dir, f), { maxHeight: 1600 }));
        }
      } else {
        for (const s of meta.screens.slice(0, 8)) {
          content.push(await imageBlock(path.join(dir, s.path), { maxHeight: 1600 }));
        }
      }
    } else if (images === "components") {
      const items = meta.source_type === "web" ? meta.components : meta.screens;
      for (const c of items.slice(0, 10)) {
        content.push(await imageBlock(path.join(dir, c.path), { maxWidth: 1000 }));
      }
    }
    return ok(content);
  } catch (err) { return fail(err); }
});

server.registerTool("list_components", {
  description: `Show component crops of one type across all designs (e.g. every "pricing" section). Types: ${COMPONENT_TYPES.join(", ")}; app screens are "screen:<name>".`,
  inputSchema: {
    type: z.string().describe("Component type to collect"),
    query: z.string().optional().describe("Substring filter on the component description"),
    limit: z.number().int().min(1).max(15).default(8),
  },
}, async ({ type, query, limit }) => {
  try {
    const db = openDb();
    const rows = db.prepare(
      `SELECT d.slug, c.type, c.path, c.description FROM components c
       JOIN designs d ON d.id = c.design_id
       WHERE c.type = ? AND (? IS NULL OR c.description LIKE '%' || ? || '%')
       ORDER BY d.captured_at DESC LIMIT ?`
    ).all(type, query ?? null, query ?? null, limit) as { slug: string; type: string; path: string; description: string }[];
    db.close();
    const content: Block[] = [];
    for (const r of rows) {
      content.push({ type: "text", text: `${r.slug} — ${r.type}: ${r.description}` });
      content.push(await imageBlock(path.join(designDir(r.slug), r.path), { maxWidth: 1000 }));
    }
    return ok(content);
  } catch (err) { return fail(err); }
});

server.registerTool("compare_designs", {
  description: "Side-by-side comparison of 2-4 entries: thumbnails plus palette/typography/tag differences.",
  inputSchema: { slugs: z.array(z.string()).min(2).max(4) },
}, async ({ slugs }) => {
  try {
    const content: Block[] = [];
    for (const slug of slugs) {
      const meta = readMeta(slug);
      content.push({
        type: "text",
        text: [
          `## ${slug}`,
          `category: ${meta.category} | tags: ${meta.tags.join(", ")}`,
          `palette: ${meta.palette.map((p) => `${p.hex}(${p.role})`).join(" ")}`,
          `type: ${meta.typography.families.join(", ")} @ ${meta.typography.scale} — ${meta.typography.notes}`,
        ].join("\n"),
      });
      const src = thumbnailSource(meta);
      if (src) content.push(await imageBlock(src, { maxWidth: 768 }));
    }
    return ok(content);
  } catch (err) { return fail(err); }
});

server.registerTool("list_tags", {
  description: "The controlled vocabularies (style tags, categories, component types) with usage counts — consult before searching.",
  inputSchema: {},
}, async () => {
  try {
    const db = openDb();
    const counts = new Map(listTagCounts(db).map((t) => [t.tag, t.count]));
    db.close();
    const tagLines = STYLE_TAGS.map((t) => `${t} (${counts.get(t) ?? 0})`).join(", ");
    const extras = [...counts.keys()].filter((t) => !(STYLE_TAGS as readonly string[]).includes(t));
    return ok([{
      type: "text",
      text: [
        `Style tags: ${tagLines}`,
        extras.length ? `Free-form tags in use: ${extras.map((t) => `${t} (${counts.get(t)})`).join(", ")}` : "",
        `Categories: ${CATEGORIES.join(", ")}`,
        `Component types: ${COMPONENT_TYPES.join(", ")}`,
      ].filter(Boolean).join("\n\n"),
    }]);
  } catch (err) { return fail(err); }
});

server.registerTool("add_design", {
  description:
    "Add designs to the library. Web/App-Store/Play-Store URLs are captured + analyzed (~1-3 min each). Alternatively ingest a folder of your own app screenshots (folder requires name + platform). Provide exactly one of urls|folder.",
  inputSchema: {
    urls: z.array(z.string().url()).optional(),
    folder: z.string().optional().describe("Absolute path to a folder of screenshots"),
    name: z.string().optional().describe("App name (required with folder)"),
    platform: z.enum(["ios", "android", "macos", "web"]).optional(),
    note: z.string().optional().describe("Why this design is worth saving — gets indexed"),
    force: z.boolean().default(false).describe("Re-capture over a same-day entry"),
  },
}, async ({ urls, folder, name, platform, note, force }) => {
  try {
    if ((urls ? 1 : 0) + (folder ? 1 : 0) !== 1) {
      throw new Error("Provide exactly one of: urls, folder");
    }
    const lines: string[] = [];
    if (folder) {
      if (!name || !platform) throw new Error("folder ingestion requires name and platform");
      const slug = await ingestFolder({ folder, name, platform, note });
      const meta = await analyze(slug);
      lines.push(`saved: ${slug} [${meta.status}] tags=${meta.tags.join(",")}`);
    } else {
      for (const url of urls!) {
        console.error(`good-eye: capturing ${url}…`);
        try {
          const slug = isStoreUrl(url) ? await ingestAppStore(url, note) : await captureWeb(url, { note, force });
          console.error(`good-eye: analyzing ${slug}…`);
          const meta = await analyze(slug);
          lines.push(`saved: ${slug} [${meta.status}] tags=${meta.tags.join(",")}`);
        } catch (err) {
          lines.push(`failed: ${url} — ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    return ok([{ type: "text", text: lines.join("\n") }]);
  } catch (err) { return fail(err); }
});

server.registerTool("reindex", {
  description: "Rebuild the search catalog from the files on disk (meta.json is the source of truth).",
  inputSchema: {},
}, async () => {
  try {
    const db = openDb();
    const n = reindexAll(db);
    db.close();
    return ok([{ type: "text", text: `Reindexed ${n} entries.` }]);
  } catch (err) { return fail(err); }
});

await server.connect(new StdioServerTransport());
console.error("good-eye MCP server ready");
