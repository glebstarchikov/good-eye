#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

run() {
  if [ "$DRY" = 1 ]; then echo "DRY: $*"; else "$@"; fi
}

NODE_BIN="$(command -v node)"
TSX="$REPO/node_modules/tsx/dist/cli.mjs"
SERVER="$REPO/src/server.ts"
HOOK="$REPO/hooks/design-prompt.sh"
SETTINGS="$HOME/.claude/settings.json"

echo "== good-eye install (repo: $REPO) =="

# 1. Dependencies
run npm --prefix "$REPO" install
if [ "$DRY" = 1 ]; then echo "DRY: npx playwright install chromium"; else (cd "$REPO" && npx playwright install chromium); fi
if [ "$DRY" = 0 ] && [ ! -f "$TSX" ]; then echo "ERROR: $TSX not found after npm install" >&2; exit 1; fi

# 2. Skill symlink
run mkdir -p "$HOME/.claude/skills"
run ln -sfn "$REPO/skill" "$HOME/.claude/skills/good-eye"

# 3. MCP server (user scope, absolute paths — GUI apps have a minimal PATH)
if [ "$DRY" = 1 ]; then
  echo "DRY: claude mcp add --scope user good-eye -- $NODE_BIN $TSX $SERVER"
else
  claude mcp remove --scope user good-eye >/dev/null 2>&1 || true
  claude mcp add --scope user good-eye -- "$NODE_BIN" "$TSX" "$SERVER"
fi

# 4. UserPromptSubmit hook (backup, then dedupe-merge)
if [ "$DRY" = 1 ]; then
  echo "DRY: merge hook into $SETTINGS (command: $HOOK)"
else
  [ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.backup-$(date +%s)"
  HOOK_CMD="$HOOK" SETTINGS_FILE="$SETTINGS" "$NODE_BIN" -e '
    const fs = require("fs");
    const file = process.env.SETTINGS_FILE, cmd = process.env.HOOK_CMD;
    const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    s.hooks ??= {};
    s.hooks.UserPromptSubmit ??= [];
    const present = JSON.stringify(s.hooks.UserPromptSubmit).includes(cmd);
    if (!present) s.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: cmd }] });
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
    console.error(present ? "hook already installed" : "hook installed");
  '
fi

# 5. Manual snippets for other clients
cat <<EOF

== Claude Desktop: add to claude_desktop_config.json ==
{
  "mcpServers": {
    "good-eye": { "command": "$NODE_BIN", "args": ["$TSX", "$SERVER"] }
  }
}

== Codex: add to ~/.codex/config.toml ==
[mcp_servers.good-eye]
command = "$NODE_BIN"
args = ["$TSX", "$SERVER"]

Done. Try: claude → "search my design library for pricing pages"
EOF
