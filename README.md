# good-eye

Personal design-inspiration database: full-page screenshots, component crops, palettes,
typography, and a written review for every site/app worth stealing from — searchable by
Claude (Code/Desktop) and Codex through the `good-eye` MCP server.

## Install

    bash scripts/install.sh

Registers the MCP server (user scope), symlinks the skill to `~/.claude/skills/good-eye`,
adds the design-prompt hook, and prints config snippets for Claude Desktop / Codex.

## Use

- Add: tell Claude "add https://stripe.com to the design library — look at their pricing"
  (or `node --import tsx src/cli.ts add <url> --note "..."` — from the repo)
- Apps: paste an App Store / Play Store link, or ingest a folder of screenshots
- Search happens automatically when you ask Claude to design something; manual:
  `node --import tsx src/cli.ts search dark pricing --tag dark-mode` (from the repo)

## Layout

- `data/designs/<slug>/` — meta.json, analysis.md, screenshots, tokens (source of truth, gitignored)
- `data/catalog.db` — derived SQLite/FTS5 index (`cli.ts reindex` rebuilds it)
- `src/` — capture pipeline, librarian, CLI, MCP server; `skill/`, `hooks/`, `scripts/`

Spec: `docs/superpowers/specs/2026-07-11-design-inspiration-db-design.md`
