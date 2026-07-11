# Design Spec: "Good Eye" — Personal Design Inspiration Database

**Date:** 2026-07-11
**Status:** Approved design, pending implementation plan
**Owner:** Gleb (solo)

## 1. Purpose

A personal, local-first library of great UI design — websites *and* apps — that Claude can search, view, and compare while designing. Turning "make it look modern" into "hero like linear.app's, pricing density like stripe.com's, palette discipline like arc.net's," backed by real pixels.

**Success criteria:**

1. From any project directory, a design-flavored prompt causes Claude to consult the library automatically (hook → skill → MCP tools) and reference concrete entries in its output.
2. `add stripe.com` completes end-to-end (capture → analysis → indexed) in under ~3 minutes on a normal connection.
3. On a library of 20+ entries, keyword/tag/category searches return a relevant entry in the top 3.
4. Works from Claude Code (any project), Claude Desktop, and Codex via the same MCP server.

**Explicit non-goals (v1):** Telegram/phone ingestion queue (designed as future Approach A, see §10), semantic/embedding search, multi-user anything, web UI, scheduled re-capture, video/interaction capture.

## 2. Architecture Overview

```
                     ┌─────────────────────────────────────────┐
                     │  ~/claude-has-a-good-eye (this repo)    │
                     │                                         │
  add_design(url) ──▶│  pipeline/capture ──▶ data/designs/<slug>/ │
                     │        │                    ▲            │
                     │        ▼                    │            │
                     │  pipeline/analyze ──────────┘            │
                     │  (claude -p, subscription)               │
                     │        │                                 │
                     │        ▼                                 │
                     │  data/catalog.db (SQLite + FTS5)         │
                     └───────────────▲─────────────────────────┘
                                     │ stdio MCP "good-eye"
        ┌────────────────┬───────────┴────────────┐
   Claude Code      Claude Desktop             Codex
   (+ hook + skill)
```

- **One Node/TypeScript package** (run via `tsx`, no build step) containing the capture pipeline, analysis runner, and MCP server.
- **Files are the source of truth** (`meta.json`, `analysis.md`, images). `catalog.db` is a derived index and can always be rebuilt with `reindex`. DB corruption never loses data.
- **Analysis rides the Claude subscription** via headless `claude -p`, not API billing.

**Stack:** Node 20+, TypeScript via `tsx`, `@modelcontextprotocol/sdk` (stdio), `playwright` (chromium only), `better-sqlite3`, `sharp` (crops/resize), `node-vibrant` (pixel palette), `zod` (librarian output validation).

## 3. Storage Layout & Data Model

```
claude-has-a-good-eye/
  src/                       # pipeline + MCP server + shared lib
  skill/                     # skill source (symlinked to ~/.claude/skills/good-eye)
  hooks/                     # hook script source
  scripts/install.sh         # registration (see §9)
  tests/
  data/                      # GITIGNORED — the database
    catalog.db
    designs/<slug>/          # slug = <domain-or-name>--YYYY-MM-DD
      meta.json              # structured facts (schema below)
      analysis.md            # librarian's written review (~300 words)
      desktop.png            # full-page @ 1440px   (web only)
      desktop-fold.png       # above-the-fold crop @ 1440×900
      mobile.png             # full-page @ 390px    (web only)
      components/*.png       # DOM-segmented sections (web only)
      screens/*.png          # app screenshots (app entries only)
      page.html              # rendered post-JS DOM (web only)
      styles.css             # collected stylesheets (web only)
      tokens.json            # colors, type scale, spacing, radii, shadows
```

- Dated slugs make re-adding a URL create a new **version**; entries for the same domain are linked in queries by `domain`. Sites redesign; history is a feature.
- `data/` is gitignored. Backup = copy the directory (or enable git-lfs later; out of scope).

### meta.json (canonical record)

```jsonc
{
  "slug": "stripe-com--2026-07-11",
  "source_type": "web",            // "web" | "app"
  "platform": "web",               // web | ios | android | macos
  "url": "https://stripe.com",     // or App Store / Play Store URL; null for manual app imports
  "domain": "stripe.com",          // or app name for apps
  "title": "Stripe — Financial infrastructure",
  "category": "saas-landing",      // one of the category vocabulary
  "status": "complete",            // complete | partial | needs-analysis
  "captured_at": "2026-07-11T14:03:00Z",
  "note": "look at their pricing table",   // curator note passed at add time
  "tags": ["gradient-heavy", "typography-led", "airy", "corporate"],
  "palette": [ { "hex": "#635BFF", "role": "primary", "prominence": 0.18 } ],
  "typography": { "families": ["sohne-var"], "scale": "15/18/24/38/56", "notes": "single family, weight-driven hierarchy" },
  "components": [ { "type": "pricing", "path": "components/pricing.png", "description": "3 tiers, middle card emphasized with gradient border" } ],
  "screens": []                    // app entries: [{ name, path, description }]
}
```

### SQLite schema (derived from meta.json files)

```sql
CREATE TABLE designs (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  url TEXT, domain TEXT, title TEXT,
  source_type TEXT NOT NULL CHECK(source_type IN ('web','app')),
  platform TEXT, category TEXT, status TEXT,
  captured_at TEXT NOT NULL, note TEXT
);
CREATE TABLE tags       (design_id INTEGER REFERENCES designs(id), tag TEXT);
CREATE TABLE components (design_id INTEGER REFERENCES designs(id), type TEXT, path TEXT, description TEXT);
CREATE TABLE colors     (design_id INTEGER REFERENCES designs(id), hex TEXT, role TEXT, prominence REAL);
CREATE VIRTUAL TABLE designs_fts USING fts5(
  slug, title, category, tags, note, analysis, components_text
);
```

`reindex` drops and rebuilds all tables by walking `data/designs/*/meta.json` + `analysis.md`.

## 4. Capture Pipeline (web entries)

`tsx src/cli.ts capture <url> [--note "..."]`

1. Launch headless Chromium. Viewport **1440×900** (desktop), then **390×844** (mobile).
2. Load with `networkidle` + timeout 30s; **auto-scroll** to bottom to trigger lazy-load; scroll back to top; best-effort cookie-banner dismissal (small selector list: `[id*=cookie] button`, `[class*=consent] button[class*=accept]`, etc. — miss is acceptable).
3. Screenshots: full-page desktop (`desktop.png`), above-fold crop (`desktop-fold.png`), full-page mobile (`mobile.png`).
4. **Component crops via DOM segmentation** (not vision bounding boxes): screenshot each of `header`, `nav`, `footer`, and each direct `main > section` / top-level `section`; plus heuristic matches (`[class*=pricing]`, `[class*=testimonial]`, `[class*=faq]`, `[class*=hero]`). Skip elements < 100px tall or invisible. Cap at 15 crops. Names are provisional (`section-3.png`) — the librarian renames/describes them.
5. Save `page.html` (post-JS `document.documentElement.outerHTML`) and `styles.css` (concatenated reachable stylesheets; skip cross-origin fetch failures silently).
6. `tokens.json`: **declared tokens** (`:root` CSS custom properties, computed font families/sizes/weights actually in use, radii/shadows sampled from computed styles) + **empirical palette** (node-vibrant on desktop-fold). Both are kept; the librarian reconciles.

**App entries** skip capture:
- **App Store / Play Store URL** → scrape the listing page's screenshot carousel image URLs, download into `screens/`, grab title/platform from the listing. Best-effort; scrape failure → error message telling the user to use the folder path instead.
- **Local folder** (`add_design({folder, name, platform})`) → copy images into `screens/`, empirical palette via node-vibrant across screens. No DOM artifacts; `tokens.json` contains palette only.

Capture ends by writing a **provisional `meta.json`** (slug, url, source_type, platform, captured_at, note, `status: "needs-analysis"`) so `analyze` — and `reindex` — always have a record to work from.

**Thumbnail rule:** every entry has a canonical thumbnail — `desktop-fold.png` for web, the first screen for apps. Search results and compares use it.

**Failure handling:** any partial capture saves what it got and marks `status: "partial"`; analysis still runs on whatever exists. Hard failures (DNS, 4xx/5xx on first load) → no entry created, clear error returned. No retry machinery in v1.

## 5. Analysis Pass — "the librarian"

`tsx src/cli.ts analyze <slug>`

Invokes `claude -p` headlessly (default `--model sonnet`, overridable via `GOOD_EYE_MODEL`), with Read access to the entry directory, prompting it to study `desktop.png`/`mobile.png`/`screens/*`, component crops, and `tokens.json`, then emit **strict JSON** (validated with zod; one retry with the validation error appended; second failure → `status: "needs-analysis"`, add succeeds with a warning):

- `category` — one of: `saas-landing, marketing, dashboard, portfolio, ecommerce, docs, blog, mobile-app, desktop-app, other`
- `tags` — **from the controlled vocabulary in §5.1** (2–7 tags) + up to 3 free-form extras
- `palette` — reconciled hex + role (`primary/accent/background/surface/text`) + prominence, merging declared tokens with the empirical palette
- `typography` — families, approximate scale, one-line hierarchy note
- `components` (web) — for each crop: canonical `type` (vocabulary in §5.2), one-line description, and a rename of the provisional file
- `screens` (app) — name + one-line description per screenshot
- `review` — ~300 words: what makes the design work, signature moves, what's worth stealing → written to `analysis.md`

Then writes `meta.json`, renames component files, and upserts the SQLite index.

### 5.1 Controlled tag vocabulary (~40)

- **Style:** minimal, maximalist, brutalist, neo-brutalist, glassmorphic, neumorphic, flat, editorial, playful, corporate, luxury, retro, futuristic, organic, geometric, hand-crafted
- **Color/tone:** dark-mode, light-mode, monochrome, high-contrast, pastel, vibrant, gradient-heavy, muted, duotone
- **Layout:** dense, airy, grid-led, asymmetric, single-column, split-screen, full-bleed, card-based, bento
- **Content-led:** typography-led, photo-led, illustration-led, 3d-led, video-led, data-viz-led, motion-heavy

Rationale: consistent tags are what make search connect entries; "clean" on one site and "uncluttered" on another never meet. Free-form extras exist so the vocabulary can evolve deliberately (promote recurring extras into the vocabulary).

### 5.2 Component type vocabulary

`nav, hero, features, pricing, testimonials, social-proof, cta, footer, faq, stats, gallery, form, table, product-card, blog-list, onboarding, dashboard-shell, settings, empty-state, modal, other`

## 6. MCP Server — `good-eye`

Stdio server (`tsx src/server.ts`), registered user-scope in Claude Code, plus Claude Desktop and Codex configs. Tools:

| Tool | Input | Output |
|---|---|---|
| `add_design` | exactly one of `urls: string[]` \| `folder: string` (folder requires `name` + `platform`); optional `note` | Per item: slug, status, tag/component summary. Runs capture→analyze synchronously with MCP progress notifications (~1–3 min/site). |
| `search_designs` | `query?`, `tags?: string[]`, `category?`, `source_type?`, `limit=5` | Ranked matches (FTS5 + filters): metadata, palette, matched-field snippets, **thumbnail image blocks** (§4 thumbnail rule; resized ≤768px JPEG to keep tokens sane). |
| `get_design` | `slug`, `images: "fold"\|"full"\|"components"\|"none"` | Full meta + analysis.md + requested image blocks. |
| `list_components` | `type`, `query?`, `limit=8` | Component crops of that type across all designs, with descriptions ("show me 8 great pricing sections"). |
| `compare_designs` | `slugs: string[2..4]` | Side-by-side fold images + palette/typography diff table. |
| `list_tags` | — | Tag + category vocabulary with usage counts (helps form good queries). |
| `reindex` | — | Rebuild catalog.db from files. |

Images always go out as MCP image content blocks — any vision-capable client gets real pixels. Full-page PNGs are served resized (≤1600px tall per image) unless a client explicitly needs more; component crops go out near-native.

## 7. Claude Code Integration

**Skill** (`skill/` in repo, symlinked to `~/.claude/skills/good-eye`) — the methodology, not tool docs:

- **When:** any UI design/redesign/critique task, before proposing visuals.
- **Query strategy:** 2–4 searches (category first, then style tags, then specific components); check `list_tags` when unsure of vocabulary.
- **Reference discipline:** pull 2–4 entries max; actually view fold crops; extract concrete tokens (palette, type scale, spacing patterns) into the new design; **synthesize, never copy** — name which reference influenced which decision.
- **Curation etiquette:** when the user shares a great link mid-conversation, offer to `add_design` it with a note capturing *why* it was shared.
- **Fallback:** if the MCP server isn't connected, run the CLI directly (`tsx <repo>/src/cli.ts ...`).

**Hook** (`UserPromptSubmit`, registered in `~/.claude/settings.json`): a small script that regex-matches design-flavored prompts (`design, redesign, landing page, hero, UI, UX, dashboard, mockup, wireframe, style, theme, branding, visual, look and feel, pricing page…`, case-insensitive, word-boundaried) and injects one line of `additionalContext`: *"Personal design library available — use the good-eye skill / MCP tools to pull real references before proposing visuals."* False positives cost one line; false negatives cost the whole feature. Claude Desktop/Codex have no hooks — tool descriptions carry the weight there.

## 8. Error Handling Summary

| Failure | Behavior |
|---|---|
| Page won't load (DNS/4xx/5xx) | No entry; clear error to caller |
| Partial capture (banner stuck, lazy-load missed, bot-blocked) | Save artifacts, `status: partial`, analysis proceeds |
| Librarian JSON invalid twice | Entry saved, `status: needs-analysis`; `analyze <slug>` re-runnable |
| App Store scrape fails | Error suggesting the screenshots-folder path |
| catalog.db corrupt/missing | `reindex` rebuilds from files |
| Duplicate URL same day | Refuse; suggest `--force` (overwrites same-day slug) |

## 9. Installation & Registration

`scripts/install.sh`:
1. `npm install` + `npx playwright install chromium`
2. Symlink `skill/` → `~/.claude/skills/good-eye`
3. `claude mcp add --scope user good-eye -- npx tsx <repo>/src/server.ts`
4. Insert hook into `~/.claude/settings.json` (jq, with timestamped backup of the file first)
5. Print ready-to-paste config snippets for Claude Desktop (`claude_desktop_config.json`) and Codex (`config.toml`) — manual paste, their files aren't ours to edit blindly.

## 10. Future (explicitly out of scope, design-compatible)

- **Phone capture (Approach A):** free Supabase Edge Function as Telegram webhook → queue table → a Mac `launchd` drainer feeding the same CLI. Pipeline already takes URLs from argv; the drainer is ~30 lines.
- Embedding search over analyses if FTS proves too literal at scale.
- Scheduled re-capture of favorites (versioning already supports it).

## 11. Testing

- **Deterministic capture test:** local fixture site (`tests/fixtures/site/` served statically) → assert artifacts exist, PNGs non-trivial, tokens.json contains expected `:root` variables and fonts.
- **Librarian contract test:** zod schema validation + retry path exercised with a mocked `claude -p` (canned good/bad JSON).
- **Index round-trip:** ingest fixture meta.json → `search_designs` returns it for tag, category, and FTS queries; `reindex` from files reproduces identical rows.
- **MCP smoke:** spawn server over stdio, call `list_tags` + `search_designs`, assert image block present.
- **Manual live smoke (not CI):** `add stripe.com` end-to-end, then `find "pricing"`.
