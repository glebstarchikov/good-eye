import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDataDir, startFixtureServer } from "./helpers.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const fakeClaude = path.join(here, "fixtures", "librarian", "fake-claude.sh");

let base: string;
let close: () => void;

function cli(args: string[], dataDir: string) {
  return execFileAsync("node", ["--import", "tsx", path.join(repo, "src", "cli.ts"), ...args], {
    cwd: repo,
    env: { ...process.env, GOOD_EYE_DATA_DIR: dataDir, GOOD_EYE_CLAUDE_BIN: fakeClaude },
  });
}

before(async () => { ({ base, close } = await startFixtureServer()); });
after(() => close());

test("add -> search round trip through the real CLI", async () => {
  const dataDir = tempDataDir();
  const added = await cli(["add", base, "--note", "cli e2e"], dataDir);
  assert.match(added.stdout, /^saved: .+\[complete\]/m);

  const found = await cli(["search", "restraint"], dataDir);
  assert.match(found.stdout, /127-0-0-1/); // slug derived from fixture host

  const reindexed = await cli(["reindex"], dataDir);
  assert.match(reindexed.stdout, /reindexed 1 entries/);
});

test("unknown command exits 1", async () => {
  const dataDir = tempDataDir();
  await assert.rejects(() => cli(["frobnicate"], dataDir), (err: { code: number }) => err.code === 1);
});
