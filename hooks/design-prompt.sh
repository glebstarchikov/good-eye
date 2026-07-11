#!/bin/bash
# UserPromptSubmit hook: if the PROMPT (not the whole JSON payload — a cwd like
# ~/my-design-system must not trigger) smells like design work, remind Claude the
# good-eye library exists. stdout (exit 0) is appended to Claude's context.
# Tokens are exact words with explicit inflections — no \w* suffixes, which made
# heroku/uid/uint32/"visual studio" fire spuriously and erode trust in the hook.
command -v node >/dev/null 2>&1 || exit 0
node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let prompt = "";
  try { prompt = JSON.parse(raw).prompt ?? ""; } catch {}
  const design = /\b(design(s|ed|ing)?|redesign(s|ed|ing)?|landing page|hero\s+(section|image|banner)|ui|ux|dashboards?|mockups?|wireframes?|styles?|styling|themes?|branding|visual design|look and feel|pricing page|typography|color palette|component library)\b/i;
  if (design.test(prompt)) {
    console.log("Personal design library available — use the good-eye skill and MCP tools (search_designs, list_components, get_design) to pull real visual references before proposing any design.");
  }
});
'
exit 0
