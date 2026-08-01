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

/** "https://www.Stripe.com/" -> "stripe-com--2026-07-11" */
export function makeSlug(name: string, date: Date = new Date()): string {
  const clean = name
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, ""); // the slice can land on a separator; never leak a dash into the "--" delimiter
  return `${clean}--${date.toISOString().slice(0, 10)}`;
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
