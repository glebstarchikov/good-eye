import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const hook = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "design-prompt.sh");

async function runHook(prompt: string): Promise<string> {
  const child = execFileAsync("bash", [hook]);
  child.child.stdin!.end(JSON.stringify({ prompt, cwd: "/tmp/x" }));
  const { stdout } = await child;
  return stdout.trim();
}

test("design-flavored prompts trigger the reminder", async () => {
  for (const p of ["redesign the landing page", "make the hero bolder", "improve this dashboard UI"]) {
    assert.match(await runHook(p), /good-eye/i, `expected reminder for: ${p}`);
  }
});

test("non-design prompts stay silent", async () => {
  for (const p of ["fix the failing sqlite test", "bump the node version", "write a migration"]) {
    assert.equal(await runHook(p), "", `expected silence for: ${p}`);
  }
});
