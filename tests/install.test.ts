import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install.sh");

test("install.sh --dry-run plans all five phases without executing", async () => {
  const { stdout } = await execFileAsync("bash", [script, "--dry-run"]);
  assert.match(stdout, /DRY: .*ln -sfn .*skill .*skills\/good-eye/);
  assert.match(stdout, /DRY: claude mcp add --scope user good-eye/);
  assert.match(stdout, /DRY: merge hook into .*settings\.json/);
  assert.match(stdout, /mcpServers/);        // Claude Desktop snippet
  assert.match(stdout, /mcp_servers/);       // Codex snippet
  assert.match(stdout, /tsx\/dist\/cli\.mjs/); // absolute tsx entry, not npx
});
