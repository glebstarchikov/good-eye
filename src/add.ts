import fs from "node:fs";
import path from "node:path";
import { captureWeb } from "./capture/web.js";
import { analyze, reviewIn } from "./librarian/analyze.js";
import { openDb, upsertDesign } from "./lib/db.js";
import { readAnalysis, type Meta } from "./lib/meta.js";
import { ABANDONED_AFTER_MS, designDir, ensureDir, lastTouched, stagingDir } from "./lib/paths.js";

/** Captures a web page and reviews it into the library. With force, a same-day entry for the page is
 * replaced only once the new capture and its review have both succeeded; until then, and whenever
 * either fails, the entry stays exactly as it was. */
export async function addWeb(url: string, opts: { note?: string; force?: boolean } = {}): Promise<{ slug: string; meta: Meta }> {
  if (!opts.force) {
    const slug = await captureWeb(url, { note: opts.note });
    return { slug, meta: await analyze(slug) };
  }
  clearAbandonedStaging();
  ensureDir(stagingDir());
  const stage = fs.mkdtempSync(path.join(stagingDir(), "capture-"));
  try {
    const slug = await captureWeb(url, { note: opts.note, dir: stage });
    const { meta, succeeded } = await reviewIn(stage, slug);
    if (!succeeded) throw new Error(`the review failed, so the existing entry "${slug}" was left as it was`);
    replaceEntry(stage, designDir(slug));
    const db = openDb();
    upsertDesign(db, meta, readAnalysis(slug));
    db.close();
    return { slug, meta };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Moves the reviewed copy into place. A folder can't be renamed over a non-empty one, so the old
 * entry steps aside into staging first and comes back if the second rename fails. */
function replaceEntry(stage: string, target: string): void {
  if (!fs.existsSync(target)) {
    ensureDir(path.dirname(target)); // a new library has no designs/ yet
    fs.renameSync(stage, target);
    return;
  }
  const old = path.join(stagingDir(), `replaced-${process.pid}-${Date.now()}`);
  fs.renameSync(target, old);
  try {
    fs.renameSync(stage, target);
  } catch (err) {
    fs.renameSync(old, target);
    throw err;
  }
  fs.rmSync(old, { recursive: true, force: true });
}

/** Staging copies a killed run left behind. A live one goes at most about 10 minutes without a write:
 * two review attempts of up to 5 minutes each. */
function clearAbandonedStaging(): void {
  if (!fs.existsSync(stagingDir())) return;
  for (const name of fs.readdirSync(stagingDir())) {
    const p = path.join(stagingDir(), name);
    if (Date.now() - lastTouched(p) >= ABANDONED_AFTER_MS) fs.rmSync(p, { recursive: true, force: true });
  }
}
