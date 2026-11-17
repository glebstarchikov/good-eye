#!/bin/bash
# Stand-in for the claude CLI. Prints the -p JSON envelope with a canned librarian result.
# FAKE_CLAUDE_ALWAYS_BAD=1        -> always emit bad.json
# FAKE_CLAUDE_STATE=<file>        -> emit bad.json on first call, good.json after (tests the retry)
# FAKE_CLAUDE_FENCED=1            -> wrap good.json in a ```json fence plus surrounding prose
# FAKE_CLAUDE_OUTPUT=<file>       -> emit this file instead of good.json
DIR="$(cd "$(dirname "$0")" && pwd)"
FILE="${FAKE_CLAUDE_OUTPUT:-$DIR/good.json}"
if [ -n "${FAKE_CLAUDE_STATE:-}" ]; then
  if [ ! -f "$FAKE_CLAUDE_STATE" ]; then
    echo 1 > "$FAKE_CLAUDE_STATE"
    FILE="$DIR/bad.json"
  fi
fi
if [ "${FAKE_CLAUDE_ALWAYS_BAD:-}" = "1" ]; then FILE="$DIR/bad.json"; fi
node -e '
const fs = require("fs");
let result = fs.readFileSync(process.argv[1], "utf8");
if (process.env.FAKE_CLAUDE_FENCED === "1") {
  result = "Sure, here is the analysis:\n```json\n" + result + "\n```\nLet me know if you need anything else.";
}
console.log(JSON.stringify({ type: "result", result }));
' "$FILE"
