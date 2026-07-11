import fs from "node:fs";
import path from "node:path";
import type { Meta } from "../lib/meta.js";
import { CATEGORIES, STYLE_TAGS, COMPONENT_TYPES } from "../lib/vocab.js";

export function buildPrompt(meta: Meta, dir: string): string {
  const tokens = fs.existsSync(path.join(dir, "tokens.json"))
    ? fs.readFileSync(path.join(dir, "tokens.json"), "utf8")
    : "{}";
  const images = meta.source_type === "web"
    ? ["desktop.png", "mobile.png", ...meta.components.map((c) => c.path)]
    : meta.screens.map((s) => s.path);
  const existing = fs.existsSync(dir)
    ? images.filter((rel) => fs.existsSync(path.join(dir, rel)))
    : [];
  const fileList = existing.map((rel) => path.join(dir, rel)).join("\n");
  const itemsField = meta.source_type === "web"
    ? `"components": [{ "file": "<one of the provisional component paths above>", "type": "<one of: ${COMPONENT_TYPES.join(", ")}>", "description": "<one concrete line>" }]`
    : `"screens": [{ "file": "<one of the screen paths above>", "name": "<short-kebab-name>", "description": "<one concrete line>" }]`;

  return `You are a design librarian cataloging a ${meta.source_type === "web" ? "website" : `${meta.platform} app`} for a personal design-inspiration database.

Study these images (use the Read tool on each path):
${fileList}

Extracted tokens (declared CSS variables/fonts + empirical pixel palette):
${tokens}

Curator note: ${meta.note || "(none)"}
Title: ${meta.title || meta.domain}

Respond with ONLY a JSON object (no prose, no code fences) with exactly these fields:
{
  "category": one of [${CATEGORIES.join(", ")}],
  "tags": 2-7 tags from this controlled vocabulary [${STYLE_TAGS.join(", ")}] plus at most 3 free-form extras,
  "palette": 2-8 entries { "hex": "#rrggbb", "role": "primary"|"accent"|"background"|"surface"|"text", "prominence": 0..1 } reconciling declared tokens with the empirical palette,
  "typography": { "families": [...], "scale": "e.g. 15/18/24/38/56", "notes": "one line on hierarchy" },
  ${itemsField},
  "review": "~300 words: what makes this design work, its signature moves, what is worth stealing, any weaknesses"
}`;
}
