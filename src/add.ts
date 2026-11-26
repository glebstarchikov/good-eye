import fs from "node:fs";
import path from "node:path";
import { captureWeb } from "./capture/web.js";
import { analyze, reviewIn } from "./librarian/analyze.js";
import { openDb, upsertDesign } from "./lib/db.js";
import { readAnalysis, readMeta, type Meta } from "./lib/meta.js";
import { ABANDONED_AFTER_MS, dataDir, designDir, ensureDir, lastTouched, stagingDir, webSlug } from "./lib/paths.js";

/** Captures a web page and reviews it into the library. One add per page runs at a time, across the
 * CLI, the MCP server and good-eye-app's worker. With force, an existing entry for the page is
 * replaced only once the new capture and its review have both succeeded; until then, and whenever
 * either fails, it stays exactly as it was. */
export async function addWeb(url: string, opts: { note?: string; force?: boolean } = {}): Promise<{ slug: string; meta: Meta }> {
  const slug = webSlug(url);
  const unlock = lockPage(slug);
  try {
    recoverInterruptedSwaps(slug);
    if (!opts.force || !fs.existsSync(path.join(designDir(slug), "meta.json"))) {
      const captured = await captureWeb(url, { note: opts.note });
      return { slug: captured, meta: await analyze(captured) };
    }
    return await recapture(url, slug, opts.note);
  } finally {
    unlock();
  }
}

async function recapture(url: string, slug: string, note: string | undefined): Promise<{ slug: string; meta: Meta }> {
  clearAbandonedStaging();
  ensureDir(stagingDir());
  const stage = fs.mkdtempSync(path.join(stagingDir(), "capture-"));
  try {
    await captureWeb(url, { note, dir: stage });
    const { meta, succeeded } = await reviewIn(stage, slug);
    if (!succeeded) throw new Error(`the review failed, so the existing entry "${slug}" was left as it was`);
    if (!shouldReplace(readMeta(slug).status, meta.status)) {
      throw new Error(`the re-capture came out partial, so the complete entry "${slug}" was left as it was`);
    }
    replaceEntry(stage, slug);
    const db = openDb();
    upsertDesign(db, meta, readAnalysis(slug));
    db.close();
    return { slug, meta };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** A partial re-capture (a load that broke halfway) never replaces a complete entry. */
export function shouldReplace(oldStatus: Meta["status"], newStatus: Meta["status"]): boolean {
  return !(oldStatus === "complete" && newStatus === "partial");
}

const locksDir = () => path.join(dataDir(), ".locks");

/** Takes the page's lock, an atomic mkdir. One left by a killed run is taken over after 15 minutes;
 * a live add, capture and review included, finishes well inside that. */
function lockPage(slug: string): () => void {
  const lock = path.join(locksDir(), slug);
  const busy = () => new Error(`Entry "${slug}" is still being captured; try again in a few minutes`);
  ensureDir(locksDir());
  try {
    fs.mkdirSync(lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST" || isLocked(slug)) throw busy();
    fs.rmSync(lock, { recursive: true, force: true });
    try {
      fs.mkdirSync(lock);
    } catch {
      throw busy(); // another run took the stale lock over first
    }
  }
  return () => fs.rmSync(lock, { recursive: true, force: true });
}

function isLocked(slug: string): boolean {
  const lock = path.join(locksDir(), slug);
  return fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < ABANDONED_AFTER_MS;
}

// The old entry steps aside under this prefix while the new one moves in. A folder can't be renamed
// over a non-empty one, so the swap takes two renames.
const SET_ASIDE = "replaced.";

function replaceEntry(stage: string, slug: string): void {
  const target = designDir(slug);
  const old = path.join(stagingDir(), `${SET_ASIDE}${process.pid}.${Date.now()}.${slug}`);
  fs.renameSync(target, old);
  try {
    fs.renameSync(stage, target);
  } catch (err) {
    fs.renameSync(old, target);
    throw err;
  }
  fs.rmSync(old, { recursive: true, force: true });
}

/** A run killed between the two renames leaves the old entry set aside and the page missing: put it
 * back. One killed after both just left the old copy behind: remove it. Pages another run is adding
 * right now are skipped; `own` is the page this run holds the lock for. */
function recoverInterruptedSwaps(own: string): void {
  for (const name of stagingEntries()) {
    if (!name.startsWith(SET_ASIDE)) continue;
    const slug = name.split(".").slice(3).join(".");
    if (!slug || (slug !== own && isLocked(slug))) continue;
    const setAside = path.join(stagingDir(), name);
    try {
      if (fs.existsSync(designDir(slug))) {
        fs.rmSync(setAside, { recursive: true, force: true });
      } else {
        ensureDir(path.dirname(designDir(slug)));
        fs.renameSync(setAside, designDir(slug));
      }
    } catch (err) {
      console.error(`good-eye: couldn't recover ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Staging copies a killed run left behind. A live one goes at most about 10 minutes without a write:
 * two review attempts of up to 5 minutes each. Set-aside entries are left to recoverInterruptedSwaps. */
function clearAbandonedStaging(): void {
  for (const name of stagingEntries()) {
    if (name.startsWith(SET_ASIDE)) continue;
    const p = path.join(stagingDir(), name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isDirectory() || Date.now() - lastTouched(p) >= ABANDONED_AFTER_MS) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // gone already, or another run is moving it: not ours to clear
    }
  }
}

function stagingEntries(): string[] {
  return fs.existsSync(stagingDir()) ? fs.readdirSync(stagingDir()) : [];
}
