import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ABANDONED_AFTER_MS, dataDir, ensureDir } from "./paths.js";

const locksDir = () => path.join(dataDir(), ".locks");
const busy = (slug: string) => new Error(`Entry "${slug}" is still being captured; try again in a few minutes`);

/** Whether a live run holds the page's lock. One untouched for 15 minutes belongs to a killed run. */
export function isLocked(slug: string): boolean {
  const lock = path.join(locksDir(), slug);
  return fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < ABANDONED_AFTER_MS;
}

function tryMake(lock: string): boolean {
  try {
    fs.mkdirSync(lock);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Runs fn holding the page's lock, so one capture or review of a page runs at a time across the CLI,
 * the MCP server and good-eye-app's worker. The lock is a folder (mkdir is atomic) holding its
 * owner's token, touched every minute while held. A stale one is taken over by renaming it away,
 * which only one run can do; a run only ever removes a lock it still owns. */
export async function withPageLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(locksDir(), slug);
  ensureDir(locksDir());
  if (!tryMake(lock)) {
    if (isLocked(slug)) throw busy(slug);
    const away = `${lock}.stale-${process.pid}-${randomUUID()}`;
    try {
      fs.renameSync(lock, away);
    } catch {
      throw busy(slug); // another run took it over first
    }
    if (Date.now() - fs.statSync(away).mtimeMs < ABANDONED_AFTER_MS) {
      // It was taken over and renewed between our check and our rename: give it back.
      fs.renameSync(away, lock);
      throw busy(slug);
    }
    fs.rmSync(away, { recursive: true, force: true });
    if (!tryMake(lock)) throw busy(slug);
  }
  const token = randomUUID();
  const ownerFile = path.join(lock, "owner");
  fs.writeFileSync(ownerFile, token);
  const keepFresh = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lock, now, now);
    } catch {
      // taken over while this run was suspended; the owner check below keeps it from being removed
    }
  }, 60_000);
  keepFresh.unref();
  try {
    return await fn();
  } finally {
    clearInterval(keepFresh);
    try {
      if (fs.readFileSync(ownerFile, "utf8") === token) fs.rmSync(lock, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
}
