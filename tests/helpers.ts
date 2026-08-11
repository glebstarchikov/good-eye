import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { designDir, ensureDir } from "../src/lib/paths.js";
import { writeMeta, writeAnalysis, MetaSchema, type Meta } from "../src/lib/meta.js";

/** Point GOOD_EYE_DATA_DIR at a fresh temp dir; returns it. Call first in every data-touching test. */
export function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "good-eye-test-"));
  process.env.GOOD_EYE_DATA_DIR = dir;
  return dir;
}

export function fixtureMeta(overrides: Partial<Meta> = {}): Meta {
  return MetaSchema.parse({
    slug: "example-com--2026-01-01",
    source_type: "web",
    platform: "web",
    url: "https://example.com",
    domain: "example.com",
    title: "Example — a fine site",
    category: "saas-landing",
    status: "complete",
    captured_at: "2026-01-01T00:00:00.000Z",
    note: "",
    tags: ["minimal", "airy"],
    palette: [{ hex: "#635BFF", role: "primary", prominence: 0.2 }],
    typography: { families: ["Inter"], scale: "16/24/40", notes: "" },
    components: [{ type: "hero", path: "components/hero.png", description: "big hero" }],
    screens: [],
    ...overrides,
  });
}

export function seedEntry(meta: Meta, analysis?: string): void {
  ensureDir(designDir(meta.slug));
  writeMeta(meta);
  if (analysis !== undefined) writeAnalysis(meta.slug, analysis);
}

/** Serve tests/fixtures/site on an ephemeral port. */
export async function startFixtureServer(): Promise<{ base: string; close: () => void }> {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "site");
  const sockets = new Set<import("node:net").Socket>();
  let flakyReloadServed = 0;
  let deadReloadServed = 0;
  const server = http.createServer((req, res) => {
    // /hang holds the connection open forever, so a page fetching it never reaches
    // networkidle — mirrors analytics-heavy production sites (Stripe et al.).
    if (req.url === "/hang") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("streaming");
      return; // deliberately never res.end()
    }
    // A script that never finishes loading. As a `defer` subresource this pins DOMContentLoaded
    // open forever — the production failure, reproduced without touching the network.
    if (req.url === "/hang.js" || req.url === "/hang-async.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      return; // headers only, body never ends
    }
    // How an edge WAF refuses an automated client: a hard 403 before any page is served.
    if (req.url === "/forbidden") { res.writeHead(403); return res.end("Forbidden"); }
    // A WAF interstitial served *with* an error status — Cloudflare has long used 503 for this.
    // The body is a challenge, so it must classify as blocked (retryable), not as an http-error.
    if (req.url === "/challenge-503") {
      res.writeHead(503, { "content-type": "text/html" });
      return res.end(
        '<!doctype html><html><head><title>Just a moment...</title></head><body>' +
        '<div id="challenge-running">Checking your browser</div>' +
        '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>'
      );
    }
    // A gating script that redirects before stalling: the pending request ends up at the redirect
    // target, while the DOM still says /redirected-script.js. Recovery must not depend on those
    // matching. 302 -> /hang.js, which never completes.
    if (req.url === "/redirected-script.js") {
      res.writeHead(302, { location: "/hang.js" });
      return res.end();
    }
    // Serves the stalled page once, then accepts the reload connection and never answers at all,
    // so page.reload() rejects rather than returning a response.
    if (req.url === "/dead-reload") {
      if (deadReloadServed++ === 0) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(
          '<!doctype html><html><head><title>DeadReloadCo</title>' +
          '<script defer src="/hang.js"></script></head><body><h1>Dead</h1></body></html>'
        );
      }
      return; // no writeHead, no end — the reload never gets headers
    }
    // Serves the stalled-deferred-script page once, then rate-limits. Mirrors an origin that
    // throttles the immediate reload: the 429 body parses fine and carries no challenge marker,
    // so an unchecked reload response would capture the error page as though it were the site.
    if (req.url === "/flaky-reload") {
      if (flakyReloadServed++ === 0) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(
          '<!doctype html><html><head><title>FlakyCo</title>' +
          '<script defer src="/hang.js"></script></head><body><h1>Flaky</h1></body></html>'
        );
      }
      res.writeHead(429, { "content-type": "text/html" });
      return res.end("<!doctype html><html><head><title>Too Many Requests</title></head><body>Slow down</body></html>");
    }
    // A document that arrives slowly but does arrive — fourseasons.com takes 32s to reach
    // DOMContentLoaded. It must outlive the deferred-script budget without being called blocked.
    if (req.url === "/slow-parse") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<!doctype html><html><head><title>SlowCo</title></head><body><h1>Slow</h1>");
      setTimeout(() => res.end("<p>but fine</p></body></html>"), 3000);
      return;
    }
    // A document that never finishes arriving, so the parser stays in readyState "loading".
    // This is the shape a stalled bot challenge has, and what must classify as "blocked".
    if (req.url === "/never-ends") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<!doctype html><html><head><title>Stuck</title></head><body><p>partial");
      return; // deliberately never res.end()
    }
    const file = path.join(fixtures, req.url === "/" ? "index.html" : req.url!.slice(1));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": file.endsWith(".css") ? "text/css" : "text/html" });
    res.end(fs.readFileSync(file));
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}/`,
    close: () => { for (const s of sockets) s.destroy(); server.close(); }, // destroy the hanging socket so close() returns
  };
}
