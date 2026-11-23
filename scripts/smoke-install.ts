// Installs the committed HEAD the way the plugin installer leaves it (dependencies present, no
// install scripts run), starts the server from .mcp.json, and calls a tool that opens the catalog.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "good-eye-smoke-"));
const root = path.join(tmp, "plugin");
try {
  fs.mkdirSync(root);
  execFileSync("git", ["-C", repo, "archive", "--output", path.join(tmp, "head.tar"), "HEAD"]);
  execFileSync("tar", ["-xf", path.join(tmp, "head.tar"), "-C", root]);
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });

  const { command, args } = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers["good-eye"];
  const client = new Client({ name: "good-eye-smoke", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command,
    args: args.map((a: string) => a.replaceAll("${CLAUDE_PLUGIN_ROOT}", root)),
    env: { ...process.env, GOOD_EYE_DATA_DIR: path.join(tmp, "data") } as Record<string, string>,
  }));
  const res = await client.callTool({ name: "list_tags", arguments: {} });
  const version = client.getServerVersion()?.version;
  await client.close();
  const text = (res.content as { text: string }[])[0]?.text ?? "";
  if (res.isError) {
    console.error(`FAIL: good-eye ${version} installed without scripts, list_tags: ${text}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: good-eye ${version} installed without scripts, list_tags answered`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
