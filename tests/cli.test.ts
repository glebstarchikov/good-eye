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

test("batch add isolates per-URL failures: continues past a bad URL, exits 1", async () => {
  const dataDir = tempDataDir();
  const bad = `${base}missing-page`;
  await assert.rejects(
    () => cli(["add", bad, base, "--note", "batch"], dataDir),
    (err: { code: number; stdout: string }) => {
      assert.equal(err.code, 1);
      assert.match(err.stdout, /^failed: .*missing-page.* — /m);
      assert.match(err.stdout, /^saved: .+\[complete\]/m);
      return true;
    }
  );
});

test("unknown command exits 1", async () => {
  const dataDir = tempDataDir();
  await assert.rejects(() => cli(["frobnicate"], dataDir), (err: { code: number }) => err.code === 1);
});

test("trailing --tag with no value exits 1 with a usage error", async () => {
  const dataDir = tempDataDir();
  await assert.rejects(
    () => cli(["search", "x", "--tag"], dataDir),
    (err: { code: number; stderr: string }) => err.code === 1 && /missing value for --tag/.test(err.stderr)
  );
});

test("flag-shaped value after --tag is refused, not swallowed", async () => {
  const dataDir = tempDataDir();
  await assert.rejects(
    () => cli(["search", "x", "--tag", "--category", "y"], dataDir),
    (err: { code: number; stderr: string }) => err.code === 1 && /missing value for --tag/.test(err.stderr)
  );
});
