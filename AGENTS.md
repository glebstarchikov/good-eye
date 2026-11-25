# AGENTS.md

good-eye is Gleb's design-inspiration library: full-page screenshots, component crops, palettes, typography and a written review for each site or app, searchable by Claude over MCP. It ships as a Claude Code plugin (MCP server and a skill) from the `glebstarchikov` marketplace, and design-factory's references step reads from it. TypeScript run directly through tsx on Node 22, with SQLite FTS5, Playwright and Sharp.

Agent instructions live in this file. CLAUDE.md is the single line `@AGENTS.md`, so new instructions go here.

## Setup

`npm ci`, then `npx playwright install chromium` for capture and the tests. There is no build step: the plugin runs `src/server.ts` through tsx.

Every env var is an optional override, read from the environment (nothing loads a `.env` file). `.env.example` lists them with their defaults.

## Checks

Before you finish, run what CI runs: `npm run typecheck && npm test && npm run smoke:install`.

## Layout

- The library lives outside the checkout, in `~/.good-eye/data` or `$GOOD_EYE_DATA_DIR`. Each design is a folder under `designs/<slug>/`, and its `meta.json` and `analysis.md` are the source of truth. `catalog.db` is a derived FTS5 index that `reindex` rebuilds.
- `src/capture/` takes the screenshots: web pages through Playwright, apps from a store link or a folder of screenshots. `src/librarian/` writes the review by calling `claude -p` with Read as its only tool. `src/server.ts` is the MCP server and `src/cli.ts` runs the same operations from a shell.
- `src/lib/vocab.ts` holds the fixed categories and style tags. The librarian keeps vocabulary tags plus at most 3 free-form ones.

## Conventions

- Keep the default data folder outside the repo. Installed as a plugin, the repo is a versioned cache folder that is replaced on every upgrade, so a repo-relative default would strand the catalog. `src/lib/paths.ts` explains it.
- Tests call `tempDataDir()` from `tests/helpers.ts` first and point `GOOD_EYE_CLAUDE_BIN` at `tests/fixtures/librarian/fake-claude.sh`, so a test run never touches the real library or spends model calls. New tests do the same.
- The capture timeouts in `src/capture/web.ts` are tuned on purpose, and the comments there give the reasons. Read them before changing a budget.
- Challenge pages are recognised by live DOM structure, never by text in the HTML, because the library captures developer-tool sites that mention challenge URLs in prose.
- The plugin installer runs `npm ci --ignore-scripts`, so every dependency has to work without its install script. `npm run smoke:install` proves it; run it after adding or upgrading a dependency.
- A release bumps `version` in `package.json` and `.claude-plugin/plugin.json`, then the good-eye entry in `claude-plugins`' `.claude-plugin/marketplace.json`, including its pinned `sha`.
