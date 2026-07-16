# good-eye

A personal design-inspiration database, searchable by Claude through MCP.

Instead of scrolling through bookmarks when a project needs a design direction, good-eye keeps full-page screenshots, component crops, palettes, typography, and a written review for every site or app worth stealing from. Claude (Code, Desktop) and Codex can search it directly through the `good-eye` MCP server, so design inspiration shows up automatically while designing something rather than requiring a manual lookup.

## Stack
TypeScript, Node.js, the Model Context Protocol SDK, SQLite (FTS5), Playwright, Sharp.

## Getting started
```sh
bash scripts/install.sh
```

This registers the MCP server (user scope), symlinks the skill to `~/.claude/skills/good-eye`, adds the design-prompt hook, and prints config snippets for Claude Desktop and Codex.

Add a design: tell Claude "add https://stripe.com to the design library, look at their pricing" (or run `node --import tsx src/cli.ts add <url> --note "..."` from the repo). You can also paste an App Store or Play Store link, or ingest a folder of screenshots.

Search happens automatically when you ask Claude to design something. To search manually: `node --import tsx src/cli.ts search dark pricing --tag dark-mode`.

Layout:
- `data/designs/<slug>/` holds `meta.json`, `analysis.md`, screenshots, and tokens (the source of truth, gitignored)
- `data/catalog.db` is a derived SQLite/FTS5 index (`cli.ts reindex` rebuilds it)
- `src/` holds the capture pipeline, librarian, CLI, and MCP server; `skill/`, `hooks/`, `scripts/` hold the rest

## License
MIT

---
Part of what I build at [glebstarchikov.nl](https://glebstarchikov.nl).
