#!/bin/bash
# Stand-in for the claude CLI. Prints the -p JSON envelope with a canned librarian result.
# FAKE_CLAUDE_ALWAYS_BAD=1        -> always emit bad.json
# FAKE_CLAUDE_STATE=<file>        -> emit bad.json on first call, good.json after (tests the retry)
DIR="$(cd "$(dirname "$0")" && pwd)"
FILE="$DIR/good.json"
if [ -n "${FAKE_CLAUDE_STATE:-}" ]; then
  if [ ! -f "$FAKE_CLAUDE_STATE" ]; then
    echo 1 > "$FAKE_CLAUDE_STATE"
    FILE="$DIR/bad.json"
  fi
fi
if [ "${FAKE_CLAUDE_ALWAYS_BAD:-}" = "1" ]; then FILE="$DIR/bad.json"; fi
node -e 'const fs=require("fs");const result=fs.readFileSync(process.argv[1],"utf8");console.log(JSON.stringify({type:"result",result}))' "$FILE"
