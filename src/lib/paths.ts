import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/src/lib
export const repoRoot = path.resolve(here, "..", "..");

export function dataDir(): string {
  return process.env.GOOD_EYE_DATA_DIR ?? path.join(repoRoot, "data");
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
