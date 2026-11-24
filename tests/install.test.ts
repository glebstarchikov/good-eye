import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install.sh");

test("install.sh --dry-run plans all four phases without executing", async () => {
  const { stdout } = await execFileAsync("bash", [script, "--dry-run"]);
  const link = stdout.match(/DRY: ln -sfn (\S+) (\S+)/);
  assert.ok(link, "plans the skill symlink");
  assert.match(link[2], /\/\.claude\/skills\/good-eye$/);
  assert.ok(existsSync(path.join(link[1], "SKILL.md")), `the link's source ${link[1]} holds the skill`);
  assert.match(stdout, /DRY: claude mcp add --scope user good-eye/);
  assert.doesNotMatch(stdout, /hook|settings\.json/); // the prompt hook is gone
  assert.match(stdout, /mcpServers/);        // Claude Desktop snippet
  assert.match(stdout, /mcp_servers/);       // Codex snippet
  assert.match(stdout, /tsx\/dist\/cli\.mjs/); // absolute tsx entry, not npx
});
