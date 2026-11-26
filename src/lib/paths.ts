import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/src/lib
export const repoRoot = path.resolve(here, "..", "..");

/**
 * The library lives outside the checkout, in ~/.good-eye/data.
 *
 * It deliberately does NOT default to <repoRoot>/data: when good-eye is installed
 * as a plugin, repoRoot is the versioned plugin cache directory
 * (~/.claude/plugins/cache/.../good-eye/<version>/), which is replaced wholesale on
 * every version bump. Since data/ is gitignored and never ships with the plugin, a
 * repo-relative default would silently create an empty catalog on each upgrade and
 * strand the real one. A stable home-relative path survives both upgrades and
 * reinstalls, and keeps any absolute username out of the committed config.
 */
export function dataDir(): string {
  return process.env.GOOD_EYE_DATA_DIR ?? path.join(os.homedir(), ".good-eye", "data");
}
export function designsDir(): string {
  return path.join(dataDir(), "designs");
}
export function designDir(slug: string): string {
  return path.join(designsDir(), slug);
}
export function dbPath(): string {
  return path.join(dataDir(), "catalog.db");
}

/** Where a forced re-capture is built and reviewed before it replaces the entry. It sits beside
 * designs/, on the same disk so the final move is a rename, and outside it so nothing that lists
 * entries (reindex, the app's sync) ever sees a half-done copy. */
export function stagingDir(): string {
  return path.join(dataDir(), ".staging");
}

function cleanName(name: string, max: number): string {
  return name
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, ""); // the slice can land on a separator; never leak a dash into a delimiter
}

/** "https://www.Stripe.com/" -> "stripe-com--2026-07-11" */
export function makeSlug(name: string, date: Date = new Date()): string {
  return `${cleanName(name, 60)}--${date.toISOString().slice(0, 10)}`;
}

/** Which page a URL is: its host (with any port) without www, and its path without a trailing slash.
 * The protocol, query and # part don't count. good-eye-app's capture worker keeps a copy in
 * tools/capture-worker/page.mjs; keep the two in step. */
export function pageKey(url: string): string {
  const u = new URL(url);
  return u.host.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "");
}

/** "https://linear.app/changelog" -> "linear-app-changelog-<6 hex>--2026-11-26". The code comes from
 * the page key, so pages whose names clean up to the same words (/a_b and /a-b, a long path cut
 * short) never share an entry, and the same page always gets the same name. */
export function webSlug(url: string, date: Date = new Date()): string {
  const key = pageKey(url);
  const code = createHash("sha256").update(key).digest("hex").slice(0, 6);
  return `${cleanName(key, 53)}-${code}--${date.toISOString().slice(0, 10)}`;
}

/** A capture folder with no meta.json is one still running, or one a killed run left behind. A live
 * capture writes a file every minute or so (its own waits are 30 to 45 s), so one untouched this long
 * is abandoned. */
export const ABANDONED_AFTER_MS = 15 * 60_000;

/** When anything in dir last changed: the newest mtime of the folder and everything inside it. */
export function lastTouched(dir: string): number {
  let newest = fs.statSync(dir).mtimeMs;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    newest = Math.max(newest, fs.statSync(path.join(e.parentPath, e.name)).mtimeMs);
  }
  return newest;
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
