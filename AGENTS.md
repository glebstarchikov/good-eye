# AGENTS.md

good-eye is Gleb's design-inspiration library: full-page screenshots, component crops, palettes, typography and a written review for each site or app, searchable by Claude over MCP. It ships as a Claude Code plugin (MCP server and a skill) from the `glebstarchikov` marketplace, and design-factory's references step reads from it. TypeScript run directly through tsx on Node 22.13+ (for `node:sqlite`), with Playwright and Sharp.

Write new agent instructions here. CLAUDE.md stays the single line `@AGENTS.md`.

## Setup

`npm ci`, then `npx playwright install chromium` for capture and the tests. There is no build step: the plugin runs `src/server.ts` through tsx.

Every env var is an optional override, read from the environment (nothing loads a `.env` file). `.env.example` lists them with their defaults.

## Checks

Before you finish, run what CI runs: `npm run typecheck && npm test && npm run smoke:install`.

## Layout

- `src/capture/` takes the screenshots: web pages through Playwright, apps from a store link or a folder of screenshots. `src/librarian/` writes the review by running `claude -p` with `--allowedTools Read`, which pre-approves Read but leaves the other tools in place, on text taken from third-party pages. `src/server.ts` is the MCP server, and `src/cli.ts` is a shell front end to the same modules.
- "spec §N" in code comments means `docs/superpowers/specs/2026-07-11-design-inspiration-db-design.md`.

## Conventions

- Keep the data folder outside the repo (`~/.good-eye/data` by default). Installed as a plugin, the repo is a versioned cache folder that is replaced on every upgrade; `src/lib/paths.ts` explains it.
- Change a library entry by editing its `meta.json` or `analysis.md`, then run `reindex`. `catalog.db` is derived from those files.
- New style tags go in `STYLE_TAGS` in `src/lib/vocab.ts`. Tags outside it are capped at 3 per entry by `trimTags` in `src/librarian/analyze.ts`.
- Log with `console.error` everywhere except `src/cli.ts`: the MCP server speaks over stdout, and one stray line breaks every tool call.
- Tests call `tempDataDir()` from `tests/helpers.ts` first and point `GOOD_EYE_CLAUDE_BIN` at `tests/fixtures/librarian/fake-claude.sh`, so a test run never touches the real library or spends model calls. New tests do the same.
- `src/capture/web.ts` holds hard-won capture behaviour: the time budgets, and challenge detection by live DOM structure. Its comments give the reasons; keep that behaviour unless the task is to change it.
- The plugin installer puts `node_modules` in place without running install scripts, so every dependency has to work without one. That rules out native add-ons, and it is why SQLite is `node:sqlite` rather than better-sqlite3 (the fix in 0.2.4). Run `npm run smoke:install` after adding or upgrading a dependency.
- Merging to main ships nothing to users: they run the commit pinned by `sha` in claude-plugins' `.claude-plugin/marketplace.json`, security fixes included. A release runs `npm version <x.y.z> --no-git-tag-version`, sets the same version in `.claude-plugin/plugin.json`, merges, then points the marketplace entry's `version` and `sha` at the merge commit.
