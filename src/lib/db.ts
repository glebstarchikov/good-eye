import Database from "better-sqlite3";
import { dataDir, dbPath, ensureDir } from "./paths.js";
import { listSlugs, readAnalysis, readMeta, type Meta } from "./meta.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS designs (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  url TEXT, domain TEXT, title TEXT,
  source_type TEXT NOT NULL CHECK(source_type IN ('web','app')),
  platform TEXT, category TEXT, status TEXT,
  captured_at TEXT NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS tags       (design_id INTEGER REFERENCES designs(id), tag TEXT);
CREATE TABLE IF NOT EXISTS components (design_id INTEGER REFERENCES designs(id), type TEXT, path TEXT, description TEXT);
CREATE TABLE IF NOT EXISTS colors     (design_id INTEGER REFERENCES designs(id), hex TEXT, role TEXT, prominence REAL);
CREATE VIRTUAL TABLE IF NOT EXISTS designs_fts USING fts5(
  slug, title, category, tags, note, analysis, components_text
);
`;

export function openDb(): Database.Database {
  ensureDir(dataDir());
  const db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export function upsertDesign(db: Database.Database, meta: Meta, analysis: string): void {
  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM designs WHERE slug = ?").get(meta.slug) as { id: number } | undefined;
    if (existing) {
      for (const t of ["tags", "components", "colors"]) {
        db.prepare(`DELETE FROM ${t} WHERE design_id = ?`).run(existing.id);
      }
      db.prepare("DELETE FROM designs WHERE id = ?").run(existing.id);
      db.prepare("DELETE FROM designs_fts WHERE slug = ?").run(meta.slug);
    }
    const info = db.prepare(
      `INSERT INTO designs (slug, url, domain, title, source_type, platform, category, status, captured_at, note)
       VALUES (@slug, @url, @domain, @title, @source_type, @platform, @category, @status, @captured_at, @note)`
    ).run({
      slug: meta.slug, url: meta.url, domain: meta.domain, title: meta.title,
      source_type: meta.source_type, platform: meta.platform, category: meta.category,
      status: meta.status, captured_at: meta.captured_at, note: meta.note,
    });
    const id = info.lastInsertRowid as number;
    const insTag = db.prepare("INSERT INTO tags (design_id, tag) VALUES (?, ?)");
    for (const tag of meta.tags) insTag.run(id, tag);
    const insComp = db.prepare("INSERT INTO components (design_id, type, path, description) VALUES (?, ?, ?, ?)");
    for (const c of meta.components) insComp.run(id, c.type, c.path, c.description);
    for (const s of meta.screens) insComp.run(id, `screen:${s.name}`, s.path, s.description);
    const insColor = db.prepare("INSERT INTO colors (design_id, hex, role, prominence) VALUES (?, ?, ?, ?)");
    for (const p of meta.palette) insColor.run(id, p.hex, p.role, p.prominence);
    const componentsText = [
      ...meta.components.map((c) => `${c.type}: ${c.description}`),
      ...meta.screens.map((s) => `${s.name}: ${s.description}`),
    ].join("\n");
    db.prepare(
      `INSERT INTO designs_fts (slug, title, category, tags, note, analysis, components_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(meta.slug, meta.title, meta.category, meta.tags.join(" "), meta.note, analysis, componentsText);
  });
  tx();
}

export function reindexAll(db: Database.Database): number {
  const slugs = listSlugs();
  // One outer transaction: a corrupt meta.json must abort the rebuild, never leave a half-wiped catalog.
  db.transaction(() => {
    db.exec("DELETE FROM tags; DELETE FROM components; DELETE FROM colors; DELETE FROM designs; DELETE FROM designs_fts;");
    for (const slug of slugs) upsertDesign(db, readMeta(slug), readAnalysis(slug));
  })();
  return slugs.length;
}

export type SearchArgs = {
  query?: string;
  tags?: string[];
  category?: string;
  source_type?: "web" | "app";
  limit?: number;
};

export type SearchHit = {
  slug: string; title: string; domain: string; category: string; source_type: string;
  status: string; captured_at: string; note: string; tags: string[]; snippet: string;
};

/** Turn free text into a safe FTS5 MATCH expression: quoted tokens, implicit AND. */
function ftsQuery(q: string): string | null {
  const tokens = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.length ? tokens.map((t) => `"${t}"`).join(" ") : null;
}

export function searchDesigns(db: Database.Database, args: SearchArgs): SearchHit[] {
  const limit = args.limit ?? 5;
  let ordered: { slug: string; snippet: string }[];
  const match = args.query ? ftsQuery(args.query) : null;
  if (match) {
    ordered = db.prepare(
      `SELECT slug, snippet(designs_fts, -1, '[', ']', '…', 12) AS snippet
       FROM designs_fts WHERE designs_fts MATCH ? ORDER BY rank`
    ).all(match) as { slug: string; snippet: string }[];
  } else {
    ordered = (db.prepare("SELECT slug FROM designs ORDER BY captured_at DESC").all() as { slug: string }[])
      .map((r) => ({ slug: r.slug, snippet: "" }));
  }
  const hits: SearchHit[] = [];
  const rowStmt = db.prepare("SELECT * FROM designs WHERE slug = ?");
  const tagStmt = db.prepare("SELECT tag FROM tags WHERE design_id = ?");
  for (const { slug, snippet } of ordered) {
    const row = rowStmt.get(slug) as Record<string, unknown> | undefined;
    if (!row) continue;
    const tags = (tagStmt.all(row.id) as { tag: string }[]).map((t) => t.tag);
    if (args.category && row.category !== args.category) continue;
    if (args.source_type && row.source_type !== args.source_type) continue;
    if (args.tags && !args.tags.every((t) => tags.includes(t))) continue;
    hits.push({
      slug: row.slug as string, title: row.title as string, domain: row.domain as string,
      category: row.category as string, source_type: row.source_type as string,
      status: row.status as string, captured_at: row.captured_at as string,
      note: row.note as string, tags, snippet,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export function listTagCounts(db: Database.Database): { tag: string; count: number }[] {
  return db.prepare("SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY count DESC, tag").all() as {
    tag: string; count: number;
  }[];
}
