import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempDataDir, fixtureMeta, seedEntry } from "./helpers.js";
import { designDir, ensureDir } from "../src/lib/paths.js";
import { openDb, reindexAll } from "../src/lib/db.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let client: Client;

before(async () => {
  const dataDir = tempDataDir();
  const meta = fixtureMeta();
  seedEntry(meta, "Minimal SaaS landing, strong pricing.");
  const dir = designDir(meta.slug);
  ensureDir(path.join(dir, "components"));
  await sharp({ create: { width: 1440, height: 900, channels: 3, background: { r: 99, g: 91, b: 255 } } })
    .png().toFile(path.join(dir, "desktop-fold.png"));
  await sharp({ create: { width: 1200, height: 400, channels: 3, background: { r: 20, g: 20, b: 40 } } })
    .png().toFile(path.join(dir, "components", "hero.png"));

  const meta2 = fixtureMeta({
    slug: "darkco-com--2026-02-01", domain: "darkco.com", title: "DarkCo — analytics",
    category: "dashboard", tags: ["dark-mode", "dense"], captured_at: "2026-02-01T00:00:00.000Z",
    components: [{ type: "pricing", path: "components/pricing.png", description: "3-tier pricing table" }],
  });
  seedEntry(meta2, "Dense dark dashboard with a strong pricing page.");
  await sharp({ create: { width: 1440, height: 900, channels: 3, background: { r: 20, g: 20, b: 40 } } })
    .png().toFile(path.join(designDir(meta2.slug), "desktop-fold.png"));

  const db = openDb();
  reindexAll(db);
  db.close();

  client = new Client({ name: "good-eye-test", version: "0.0.1" });
  await client.connect(new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", path.join(repo, "src", "server.ts")],
    env: {
      ...process.env,
      GOOD_EYE_DATA_DIR: dataDir,
      GOOD_EYE_CLAUDE_BIN: path.join(repo, "tests", "fixtures", "librarian", "fake-claude.sh"),
    } as Record<string, string>,
  }));
});
after(async () => { await client.close(); });

test("lists all seven tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_design", "compare_designs", "get_design", "list_components",
    "list_tags", "reindex", "search_designs",
  ]);
});

test("search_designs returns text + image blocks", async () => {
  const res = await client.callTool({ name: "search_designs", arguments: { query: "pricing" } });
  const content = res.content as { type: string; mimeType?: string }[];
  assert.ok(content.some((c) => c.type === "text"));
  assert.ok(content.some((c) => c.type === "image" && c.mimeType === "image/jpeg"));
});

test("get_design returns analysis and honors images=none", async () => {
  const res = await client.callTool({
    name: "get_design",
    arguments: { slug: "example-com--2026-01-01", images: "none" },
  });
  const content = res.content as { type: string; text?: string }[];
  assert.ok(content.every((c) => c.type === "text"));
  assert.ok(content.some((c) => c.text?.includes("strong pricing")));
});

test("list_components serves crops by type", async () => {
  const res = await client.callTool({ name: "list_components", arguments: { type: "hero" } });
  const content = res.content as { type: string }[];
  assert.ok(content.some((c) => c.type === "image"));
});

test("list_tags includes vocabulary and counts", async () => {
  const res = await client.callTool({ name: "list_tags", arguments: {} });
  const text = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  assert.match(text, /minimal \(1\)/);
  assert.match(text, /brutalist/); // unused vocab still listed
});

test("errors come back as isError, not crashes", async () => {
  const res = await client.callTool({ name: "get_design", arguments: { slug: "nope--2020-01-01" } });
  assert.equal(res.isError, true);
});

test("compare_designs returns a summary + thumbnail per slug", async () => {
  const res = await client.callTool({
    name: "compare_designs",
    arguments: { slugs: ["example-com--2026-01-01", "darkco-com--2026-02-01"] },
  });
  const content = res.content as { type: string }[];
  assert.equal(content.filter((c) => c.type === "text").length, 2);
  assert.ok(content.filter((c) => c.type === "image").length >= 1);
});

test("compare_designs with a missing slug is isError", async () => {
  const res = await client.callTool({
    name: "compare_designs",
    arguments: { slugs: ["example-com--2026-01-01", "nope--2020-01-01"] },
  });
  assert.equal(res.isError, true);
});

test("reindex rebuilds the catalog and reports the count", async () => {
  const res = await client.callTool({ name: "reindex", arguments: {} });
  const text = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  assert.match(text, /Reindexed 2 entries/);
});

test("add_design rejects neither-urls-nor-folder as isError", async () => {
  const res = await client.callTool({ name: "add_design", arguments: {} });
  assert.equal(res.isError, true);
});

test("add_design ingests a folder and analyzes it via the fake claude", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "good-eye-server-shots-"));
  await sharp({ create: { width: 390, height: 844, channels: 3, background: { r: 240, g: 240, b: 255 } } })
    .png().toFile(path.join(folder, "shot-01.png"));
  const res = await client.callTool({
    name: "add_design",
    arguments: { folder, name: "Server Test App", platform: "ios" },
  });
  const text = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  assert.match(text, /saved: server-test-app--\d{4}-\d{2}-\d{2} \[complete\]/);
});
