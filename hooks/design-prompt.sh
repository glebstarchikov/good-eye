#!/bin/bash
# UserPromptSubmit hook: if the prompt smells like design work, remind Claude the
# good-eye library exists. stdout (exit 0) is appended to Claude's context.
# False positive cost: one line. False negative cost: the library gets forgotten.
input=$(cat)
pattern='\b(design|redesign|landing page|hero|ui|ux|dashboard|mockup|wireframe|styl(e|ing)|theme|branding|visual|look and feel|pricing page|typography|color palette|component librar)\w*'
if printf '%s' "$input" | grep -qiE "$pattern"; then
  echo "Personal design library available — use the good-eye skill and MCP tools (search_designs, list_components, get_design) to pull real visual references before proposing any design."
fi
exit 0
