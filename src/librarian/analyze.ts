import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { designDir } from "../lib/paths.js";
import {
  LibrarianOutputSchema, readAnalysis, readMeta, writeAnalysis, writeMeta,
  type LibrarianOutput, type Meta,
} from "../lib/meta.js";
import { STYLE_TAGS } from "../lib/vocab.js";
import { openDb, upsertDesign } from "../lib/db.js";
import { buildPrompt } from "./prompt.js";

const execFileAsync = promisify(execFile);

async function runClaude(prompt: string, dir: string): Promise<string> {
  const bin = process.env.GOOD_EYE_CLAUDE_BIN ?? "claude";
  const model = process.env.GOOD_EYE_MODEL ?? "sonnet";
  const { stdout } = await execFileAsync(
    bin,
    ["-p", prompt, "--output-format", "json", "--model", model, "--allowedTools", "Read", "--add-dir", dir],
    { maxBuffer: 32 * 1024 * 1024, timeout: 300_000 }
  );
  const envelope = JSON.parse(stdout) as { result?: string };
  if (typeof envelope.result !== "string") throw new Error("claude -p envelope had no result string");
  return envelope.result;
}

/** Pull a JSON object out of possibly fence-wrapped text. */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in librarian output");
  return JSON.parse(text.slice(start, end + 1));
}

/** Keep vocabulary tags plus at most 3 free-form extras (spec §5). */
function trimTags(tags: string[]): string[] {
  const known = tags.filter((t) => (STYLE_TAGS as readonly string[]).includes(t));
  const extras = tags.filter((t) => !(STYLE_TAGS as readonly string[]).includes(t)).slice(0, 3);
  return [...new Set([...known, ...extras])];
}

function applyLibrarian(meta: Meta, out: LibrarianOutput, dir: string): Meta {
  meta.category = out.category;
  meta.tags = trimTags(out.tags);
  meta.palette = out.palette;
  meta.typography = out.typography;

  // The prompt lists absolute paths so the librarian can Read them, and it echoes them back.
  // Anything outside dir comes out as "../…" and matches nothing.
  const rel = (file: string) => (path.isAbsolute(file) ? path.relative(dir, file) : file);

  if (meta.source_type === "web") {
    const claimed = out.components.flatMap((item) => {
      const existing = meta.components.find((c) => c.path === rel(item.file));
      return existing ? [{ item, existing }] : []; // librarian referenced a file we never captured
    });
    // A crop the librarian left out is one it judged not worth keeping — unless it kept none, which
    // more likely means it misread the paths, and pruning then would empty the entry. Pruned before
    // the renames below, so a name freed here is never one a kept crop has just moved onto.
    if (claimed.length) {
      const kept = new Set(claimed.map((c) => c.existing));
      for (const c of meta.components) if (!kept.has(c)) fs.rmSync(path.join(dir, c.path), { force: true });
      meta.components = meta.components.filter((c) => kept.has(c));
    }
    const used = new Set<string>();
    for (const { item, existing } of claimed) {
      let base = item.type;
      let n = 2;
      while (used.has(base)) base = `${item.type}-${n++}`;
      used.add(base);
      const newRel = path.join("components", `${base}.png`);
      fs.renameSync(path.join(dir, existing.path), path.join(dir, newRel));
      existing.path = newRel;
      existing.type = item.type;
      existing.description = item.description;
    }
  } else {
    for (const item of out.screens) {
      const existing = meta.screens.find((s) => s.path === rel(item.file));
      if (!existing) continue;
      existing.name = item.name;
      existing.description = item.description;
    }
  }

  writeAnalysis(meta.slug, out.review);
  if (meta.status === "needs-analysis") meta.status = "complete"; // partial stays partial
  return meta;
}

export async function analyze(slug: string): Promise<Meta> {
  const dir = designDir(slug);
  let meta = readMeta(slug);
  const basePrompt = buildPrompt(meta, dir);
  let lastError = "";
  let succeeded = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0
      ? basePrompt
      : `${basePrompt}\n\nYour previous output failed validation:\n${lastError}\nOutput ONLY the corrected JSON object.`;
    try {
      const raw = await runClaude(prompt, dir);
      const validated = LibrarianOutputSchema.safeParse(extractJson(raw));
      if (!validated.success) {
        lastError = validated.error.message;
        continue;
      }
      meta = applyLibrarian(meta, validated.data, dir);
      succeeded = true;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!succeeded) {
    console.error(`good-eye: analysis failed for ${slug}, status left as ${meta.status} (${lastError})`);
  }

  writeMeta(meta);
  const db = openDb();
  upsertDesign(db, meta, readAnalysis(slug));
  db.close();
  return meta;
}
