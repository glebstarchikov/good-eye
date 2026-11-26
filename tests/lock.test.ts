import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDataDir } from "./helpers.js";
import { dataDir } from "../src/lib/paths.js";
import { isLocked, withPageLock } from "../src/lib/lock.js";

const lockDir = (slug: string) => path.join(dataDir(), ".locks", slug);
const age = (p: string, minutes: number) => {
  const t = new Date(Date.now() - minutes * 60_000);
  fs.utimesSync(p, t, t);
};

test("a page's lock is held while fn runs and released after, even when fn throws", async () => {
  tempDataDir();
  await withPageLock("page", async () => assert.ok(isLocked("page")));
  assert.ok(!fs.existsSync(lockDir("page")));
  await assert.rejects(() => withPageLock("page", async () => { throw new Error("boom"); }), /boom/);
  assert.ok(!fs.existsSync(lockDir("page")));
});

test("a second run on the same page is told it's still being captured; another page is free", async () => {
  tempDataDir();
  await withPageLock("page", async () => {
    await assert.rejects(() => withPageLock("page", async () => {}), /still being captured/);
    assert.equal(await withPageLock("other", async () => "ran"), "ran");
  });
});

test("a run removes only a lock it still owns", async () => {
  tempDataDir();
  await withPageLock("page", async () => {
    fs.writeFileSync(path.join(lockDir("page"), "owner"), "a run that took it over"); // as after a takeover
  });
  assert.ok(fs.existsSync(lockDir("page")), "removed another run's lock");
});

test("a stale lock is taken over; a fresh one isn't", async () => {
  tempDataDir();
  fs.mkdirSync(lockDir("page"), { recursive: true });
  await assert.rejects(() => withPageLock("page", async () => {}), /still being captured/);
  age(lockDir("page"), 16);
  assert.equal(await withPageLock("page", async () => "ran"), "ran");
  assert.deepEqual(fs.readdirSync(path.join(dataDir(), ".locks")), []);
});

test("a held lock is kept fresh, so a long run isn't taken over", async (t) => {
  tempDataDir();
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withPageLock("page", async () => {
    age(lockDir("page"), 14);
    t.mock.timers.tick(60_000);
    assert.ok(Date.now() - fs.statSync(lockDir("page")).mtimeMs < 5_000, "the lock wasn't refreshed");
  });
});
