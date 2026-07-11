import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Point GOOD_EYE_DATA_DIR at a fresh temp dir; returns it. Call first in every data-touching test. */
export function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "good-eye-test-"));
  process.env.GOOD_EYE_DATA_DIR = dir;
  return dir;
}
