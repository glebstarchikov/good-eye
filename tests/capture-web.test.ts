import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { tempDataDir, startFixtureServer } from "./helpers.js";
import { designDir } from "../src/lib/paths.js";
import { readMeta } from "../src/lib/meta.js";
import { captureWeb, salvageOrCleanup, gotoReady, looksChallenged, clearOverlays, CaptureError } from "../src/capture/web.js";

let base: string;
let close: () => void;

before(async () => {
  ({ base, close } = await startFixtureServer());
  // Every stall path below waits out these budgets; the real 15s/30s would dominate the suite.
  process.env.GOOD_EYE_DOM_TIMEOUT_MS = "2000";
  process.env.GOOD_EYE_PARSE_TIMEOUT_MS = "4000";
  process.env.GOOD_EYE_NAV_TIMEOUT_MS = "3000";
});
after(() => {
  close();
  delete process.env.GOOD_EYE_DOM_TIMEOUT_MS;
  delete process.env.GOOD_EYE_PARSE_TIMEOUT_MS;
  delete process.env.GOOD_EYE_NAV_TIMEOUT_MS;
});

test("the deferred-script budget is never shorter than the goto timeout it replaced", async () => {
  // A guard on a number, because getting it wrong is silent. The old code allowed DOMContentLoaded
  // a full 30s and then failed; if recovery can trigger sooner than that, a required bundle that
  // merely downloads slowly gets aborted as dead and the page is reloaded without it — a page the
  // previous version captured perfectly becomes a quietly unhydrated one.
  const src = fs.readFileSync(new URL("../src/capture/web.ts", import.meta.url), "utf8");
  const dom = Number(/GOOD_EYE_DOM_TIMEOUT_MS\) \|\| (\d+)/.exec(src)?.[1]);
  const parse = Number(/GOOD_EYE_PARSE_TIMEOUT_MS\) \|\| (\d+)/.exec(src)?.[1]);
  assert.ok(dom >= 30000, `deferred-script budget must not undercut the old 30s goto, got ${dom}`);
  assert.ok(parse >= dom, `parse budget (${parse}) must not be shorter than the DOM budget (${dom})`);
});

test("captureWeb produces artifacts, tokens, and provisional meta", async () => {
  tempDataDir();
  const slug = await captureWeb(base, { note: "fixture run" });
  const dir = designDir(slug);

  for (const f of ["desktop.png", "desktop-fold.png", "mobile.png", "page.html", "styles.css", "tokens.json", "meta.json"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `missing ${f}`);
  }
  assert.ok(fs.statSync(path.join(dir, "desktop.png")).size > 1000);

  const tokens = JSON.parse(fs.readFileSync(path.join(dir, "tokens.json"), "utf8"));
  assert.equal(tokens.declared.cssVars["--brand"], "#635bff");
  assert.ok(tokens.declared.fonts.some((f: string) => /georgia/i.test(f)));
  assert.ok(tokens.empiricalPalette.length >= 1);

  const meta = readMeta(slug);
  assert.equal(meta.source_type, "web");
  assert.equal(meta.status, "needs-analysis");
  assert.equal(meta.note, "fixture run");
  assert.ok(meta.title.includes("FixtureCo"));
  assert.ok(meta.components.length >= 4, `expected >=4 section crops, got ${meta.components.length}`);
  for (const c of meta.components) {
    assert.equal(c.type, "other");
    assert.ok(fs.existsSync(path.join(dir, c.path)), `missing crop ${c.path}`);
  }
});

test("same-day duplicate is refused without force, allowed with force", async () => {
  tempDataDir();
  const slug = await captureWeb(base);
  await assert.rejects(() => captureWeb(base), /already exists/);
  const again = await captureWeb(base, { force: true });
  assert.equal(again, slug);
});

test("hard load failure creates no entry", async () => {
  const tmp = tempDataDir();
  await assert.rejects(() => captureWeb(`${base}missing-page`), /HTTP 404/);
  assert.ok(!fs.existsSync(path.join(tmp, "designs")) || fs.readdirSync(path.join(tmp, "designs")).length === 0);
});

test("salvageOrCleanup writes a provisional partial meta when a screenshot exists", () => {
  tempDataDir();
  const slug = "salvage-me--2026-01-01";
  const dir = designDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "desktop-fold.png"), "fake-png-bytes");

  const salvaged = salvageOrCleanup(dir, { slug, url: "https://example.com", domain: "example.com", note: "" });

  assert.equal(salvaged, true);
  assert.ok(fs.existsSync(path.join(dir, "meta.json")));
  const meta = readMeta(slug);
  assert.equal(meta.status, "partial");
});

test("salvageOrCleanup removes the dir when nothing was captured", () => {
  tempDataDir();
  const slug = "nothing-here--2026-01-01";
  const dir = designDir(slug);
  fs.mkdirSync(dir, { recursive: true });

  const salvaged = salvageOrCleanup(dir, { slug, url: "https://example.com", domain: "example.com", note: "" });

  assert.equal(salvaged, false);
  assert.ok(!fs.existsSync(dir));
});

test("a never-idle page still captures clean, not partial (networkidle timeout is not a degrade)", async () => {
  tempDataDir();
  const slug = await captureWeb(`${base}busy.html`, { note: "busy" });
  const meta = readMeta(slug);
  assert.equal(meta.status, "needs-analysis", "networkidle timeout alone must not mark the entry partial");
  assert.ok(fs.existsSync(path.join(designDir(slug), "desktop.png")));
});

// --- Regression: a stalled `<script defer>` must not look like an unreachable site -------------
//
// The bug this guards: DOMContentLoaded fires only after every deferred script has executed, so one
// never-resolving deferred request (a DNS-blackholed analytics beacon, in the wild) withholds the
// event permanently — even though the document parsed and the DOM is fully there. Gating navigation
// on that event made basecoatui.com, heypi.dev, devpu.sh and pagescms.org all fail as bare 30s
// timeouts. This was misread as headless-browser detection; it is not, and a real headed Chrome
// fails on it identically.

test("a stalled <script defer> still captures clean (DOMContentLoaded never fires)", async () => {
  tempDataDir();
  const slug = await captureWeb(`${base}deferred-hang.html`, { note: "defer" });

  const meta = readMeta(slug);
  assert.equal(meta.status, "needs-analysis", "a blocked DOMContentLoaded must not degrade to partial");
  assert.ok(meta.title.includes("DeferCo"));
  // Recovery is not free, and the entry has to say so — a page that lost a script must not read
  // back as a pristine capture months later when someone is judging it as a design reference.
  assert.match(meta.note, /dropping 1 dead script request/);
  assert.match(meta.note, /hang\.js/);
  assert.ok(meta.note.startsWith("defer —"), "the caller's own note must survive, not be replaced");
  const dir = designDir(slug);
  for (const f of ["desktop.png", "desktop-fold.png", "mobile.png", "page.html", "tokens.json"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `missing ${f}`);
  }
  // The mobile pass navigates too, so it must share the wait semantics or it alone forces "partial".
  assert.ok(fs.statSync(path.join(dir, "mobile.png")).size > 1000);
});

test("gotoReady classifies each failure mode distinctly", async (t) => {
  const browser: Browser = await chromium.launch();
  const open = async () => (await browser.newContext()).newPage();
  try {
    await t.test("unreachable host — no HTTP response at all", async () => {
      const page = await open();
      // Reserved-by-RFC6761 name: guaranteed not to resolve, so this never reaches a server.
      await assert.rejects(
        () => gotoReady(page, "http://good-eye-nonexistent.invalid/"),
        (err: unknown) => {
          assert.ok(err instanceof CaptureError);
          assert.equal(err.kind, "unreachable");
          assert.match(err.message, /no HTTP response|never responded|sent no HTTP/i);
          return true;
        }
      );
    });

    await t.test("HTTP error — the server answered, with a status", async () => {
      const page = await open();
      await assert.rejects(
        () => gotoReady(page, `${base}missing-page`),
        (err: unknown) => {
          assert.ok(err instanceof CaptureError);
          assert.equal(err.kind, "http-error");
          assert.match(err.message, /HTTP 404/);
          return true;
        }
      );
    });

    await t.test("403 is blocked, not a plain http-error — a real browser may still get in", async () => {
      // Measured: fourseasons.com and passalacqua.it both 403 headless and 200 in headed Chrome,
      // so this status has to reach the retry rather than being filed with 404s and given up on.
      const page = await open();
      await assert.rejects(
        () => gotoReady(page, `${base}forbidden`),
        (err: unknown) => {
          assert.ok(err instanceof CaptureError);
          assert.equal(err.kind, "blocked", "403 must be retryable");
          assert.match(err.message, /real browser/i);
          return true;
        }
      );
    });

    await t.test("blocked — 200, but the document never finishes parsing", async () => {
      const page = await open();
      await assert.rejects(
        () => gotoReady(page, `${base}never-ends`),
        (err: unknown) => {
          assert.ok(err instanceof CaptureError);
          assert.equal(err.kind, "blocked");
          // The whole point of the classification: the message has to tell the user a real
          // browser is the fix, not leave them staring at "Timeout 30000ms exceeded".
          assert.match(err.message, /challenge|interstitial/i);
          assert.match(err.message, /real browser/i);
          return true;
        }
      );
    });

    await t.test("a slow-but-real document is NOT blocked, it just needs longer", async () => {
      // The negative case for the stall classification, and a real regression: fourseasons.com
      // takes 32s to fire DOMContentLoaded. A flat budget called that "blocked" and threw away a
      // perfectly good capture, so a document still mid-parse gets the longer parse budget.
      const page = await open();
      const t0 = Date.now();
      assert.deepEqual(await gotoReady(page, `${base}slow-parse`), []);
      assert.ok(Date.now() - t0 > 2000, "must have outlasted the deferred-script budget");
      assert.ok((await page.title()).includes("SlowCo"));
    });

    await t.test("an error response on the reload is caught, not captured as the site", async () => {
      // The reload is a second chance to be lied to. A 429 error page parses cleanly and carries no
      // challenge marker, so without checking its status it would sail through and get written up
      // as a real library entry.
      const page = await open();
      await assert.rejects(
        () => gotoReady(page, `${base}flaky-reload`),
        (err: unknown) => {
          assert.ok(err instanceof CaptureError);
          assert.equal(err.kind, "http-error");
          assert.match(err.message, /HTTP 429/);
          assert.match(err.message, /on reload/);
          return true;
        }
      );
    });

    await t.test("a challenge served with an error status is blocked, not http-error", async () => {
      // WAFs commonly ship the interstitial with 503 or 429. Taking the status at face value would
      // file it as an ordinary error and deny it the real-browser retry that is exactly its remedy.
      const page = await open();
      await assert.rejects(
        () => gotoReady(page, `${base}challenge-503`),
        (err: unknown) => {
          assert.ok(err instanceof CaptureError);
          assert.equal(err.kind, "blocked", "a 503 carrying a challenge body must stay retryable");
          assert.match(err.message, /HTTP 503/);
          assert.match(err.message, /real browser/i);
          return true;
        }
      );
    });

    await t.test("a rejected reload is classified, not leaked as a raw Playwright error", async () => {
      // The reload can fail outright rather than answering. An unclassified error escaping here
      // would bypass captureWeb's retry and put the user back at a bare timeout string.
      const page = await open();
      await assert.rejects(
        () => gotoReady(page, `${base}dead-reload`),
        (err: unknown) => {
          assert.ok(err instanceof CaptureError, "must be classified, not a raw TimeoutError");
          assert.equal(err.kind, "unreachable");
          assert.match(err.message, /on reload/);
          return true;
        }
      );
    });

    await t.test("recovery works when the stalled URL is not the one in the DOM", async () => {
      // The gating script 302s before stalling, so the pending request is the redirect target
      // while the DOM still lists the original src. Recovery must not require those to match —
      // the same gap opens for a stalled import deep in a module graph.
      const page = await open();
      const blocked = await gotoReady(page, `${base}redirect-hang.html`);

      assert.ok(blocked.length > 0, "must still recover when no DOM src matches the pending URL");
      assert.ok((await page.title()).includes("RedirectCo"));
      assert.equal(await page.evaluate(() => document.readyState), "complete");
    });

    await t.test("dropping a stalled script does not drop an image sharing its URL", async () => {
      // Routes match on URL alone, but a URL is not owned by one resource type. This page requests
      // /dual-use twice — as a script, where it hangs, and as an image, where it serves fine. Only
      // the script may be aborted; taking the image too would strip content out of the capture
      // recovery is meant to rescue.
      const page = await open();
      const blocked = await gotoReady(page, `${base}dual-use.html`);

      assert.ok(blocked.includes(`${base}dual-use`), "the stalled script URL must be blocked");
      const img = await page.evaluate(() => {
        const el = document.getElementById("shared") as HTMLImageElement | null;
        return { complete: el?.complete ?? false, width: el?.naturalWidth ?? 0 };
      });
      assert.equal(img.complete, true, "the image at the same URL must still load");
      assert.ok(img.width > 0, "the image must have actually decoded, not just settled");
    });

    await t.test("blocked — 200, parses fine, but serves a challenge page", async () => {
      const page = await open();
      await assert.rejects(
        () => gotoReady(page, `${base}challenge.html`),
        (err: unknown) => {
          assert.ok(err instanceof CaptureError);
          assert.equal(err.kind, "blocked");
          return true;
        }
      );
    });

    await t.test("a stalled deferred script is dropped, leaving a fully loaded page", async () => {
      const page = await open();
      const blocked = await gotoReady(page, `${base}deferred-hang.html`); // must not reject

      assert.deepEqual(blocked, [`${base}hang.js`], "the stalled script is reported for reuse");
      assert.ok((await page.title()).includes("DeferCo"));
      // The page must end up genuinely healthy, not merely screenshot-able. document.fonts.ready
      // is the one that matters: page.screenshot() awaits it unconditionally, so if the reload
      // left the document pinned, every screenshot downstream would hang for its full timeout.
      assert.equal(await page.evaluate(() => document.readyState), "complete");
      await page.evaluate(() => document.fonts.ready); // would hang, and time out the test, if pinned
    });

    await t.test("a healthy page reports nothing blocked and needs no reload", async () => {
      const page = await open();
      assert.deepEqual(await gotoReady(page, `${base}index.html`), []);
    });

    await t.test("a module script gates DOMContentLoaded even though .defer reads false", async () => {
      // Modules are deferred by default and gate the event, yet HTMLScriptElement.defer reads false
      // for them. The Cloudflare beacon behind this whole fix ships as type="module", so a
      // `defer`-only filter would sail straight past the actual culprit and the page would still
      // fail. This page also carries a dead `async` script, which must not be what we blame.
      const page = await open();
      const blocked = await gotoReady(page, `${base}module-hang.html`);

      assert.ok(blocked.includes(`${base}hang.js`), "the gating module script must be identified");
      assert.ok((await page.title()).includes("ModuleCo"));
      // Reaching "complete" is the property that matters: page.screenshot() waits on
      // document.fonts.ready, which Chrome withholds until the document finishes loading. Any
      // request left hanging here would cost the capture entirely, not just that one script.
      assert.equal(await page.evaluate(() => document.readyState), "complete");
      await page.evaluate(() => document.fonts.ready); // hangs the test if the document is pinned
    });
  } finally {
    await browser.close();
  }
});

test("a page whose dead scripts are module + async still captures end to end", async () => {
  // The end-to-end guard for the above. Leaving any dead request in flight keeps the load event
  // from firing, so document.fonts.ready never settles and every page.screenshot() burns its full
  // 30s timeout — turning "one script missing" into "no capture at all".
  tempDataDir();
  const slug = await captureWeb(`${base}module-hang.html`, { note: "module" });
  const meta = readMeta(slug);
  assert.equal(meta.status, "needs-analysis");
  assert.ok(fs.statSync(path.join(designDir(slug), "desktop.png")).size > 1000);
  assert.ok(fs.existsSync(path.join(designDir(slug), "mobile.png")));
});

test("challenge detection does not fire on a page that merely talks like one", async () => {
  // The negative case. Matching on the "Just a moment" title or "checking your browser" copy would
  // misclassify legitimate sites as blocked and send them down a pointless real-browser retry —
  // so detection keys on the cdn-cgi / __cf_chl plumbing instead, which prose cannot imitate.
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();

    await page.goto(`${base}patient.html`);
    assert.equal(await looksChallenged(page), false, "prose about checking your browser is not a challenge");

    // The harder negative: a page that prints every challenge marker verbatim as documentation.
    // A substring scan of the serialized HTML flags this, and no headed retry could ever rescue it
    // — the markers *are* the content. This library captures developer-tool sites, so it is a
    // realistic page to meet, not a contrived one.
    await page.goto(`${base}cloudflare-docs.html`);
    assert.equal(await looksChallenged(page), false, "an article about challenges is not a challenge");

    await page.goto(`${base}challenge.html`);
    assert.equal(await looksChallenged(page), true, "real challenge markup must still be caught");

    await page.goto(`${base}index.html`);
    assert.equal(await looksChallenged(page), false, "an ordinary page is not a challenge");
  } finally {
    await browser.close();
  }
});

test("a page that merely talks like a challenge captures normally, end to end", async () => {
  tempDataDir();
  const slug = await captureWeb(`${base}patient.html`, { note: "negative case" });
  assert.equal(readMeta(slug).status, "needs-analysis");
});

test("clearOverlays", async (t) => {
  const browser = await chromium.launch();
  const open = async (html: string): Promise<Page> => {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.setContent(html);
    return page;
  };
  const shown = (page: Page, sel: string) => page.locator(sel).isVisible();
  try {
    await t.test("accepts a consent banner by its button's name, never its settings button", async () => {
      // The openai.com failure: clicking the *first* button in anything named cookie opened the
      // preferences modal, and that modal became the capture. The hidden OneTrust button is a
      // leftover a stale match would pick first and then time out on.
      const page = await open(`
        <body style="margin:0">
        <div style="display:none"><button id="onetrust-accept-btn-handler">Accept All Cookies</button></div>
        <main style="height:3000px"><h1>Hello</h1>
          <button id="cta" onclick="window.ctaClicked = 1">Accept invitation</button>
          <button onclick="window.ctaClicked = 1">Cards we accept</button></main>
        <div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;padding:24px;background:#eee">
          We use cookies.
          <button onclick="window.settings = 1">Cookie settings</button>
          <button onclick="document.getElementById('cookie-banner').remove()">Accept all</button>
        </div></body>`);
      await clearOverlays(page);
      assert.equal(await page.locator("#cookie-banner").count(), 0, "banner should be accepted away");
      assert.equal(await page.evaluate(() => (window as any).settings), undefined, "settings must not be clicked");
      assert.equal(await page.evaluate(() => (window as any).ctaClicked), undefined, "a CTA that merely says accept is not consent");
    });

    await t.test("closes a popup that listens for Escape", async () => {
      const page = await open(`
        <body><main style="height:3000px">Page</main>
        <div id="promo" style="position:fixed;top:30%;left:30%;padding:40px;background:#fff">20% off today</div>
        <script>addEventListener("keydown", (e) => { if (e.key === "Escape") document.getElementById("promo").remove(); });</script>
        </body>`);
      await clearOverlays(page);
      assert.equal(await page.locator("#promo").count(), 0);
    });

    await t.test("hides modal dialogs and their backdrops", async () => {
      // Both backdrop shapes in one page: a wrapper around the dialog, and a sibling layer (Radix).
      const page = await open(`
        <body style="margin:0">
        <main style="height:3000px"><h1>Store</h1></main>
        <div id="wrap" style="position:fixed;inset:0;background:rgba(0,0,0,.5)">
          <div id="news" role="dialog" aria-modal="true" style="margin:20vh auto;width:400px;background:#fff">
            Join our newsletter <input> <button>Subscribe</button></div></div>
        <div id="veil" style="position:fixed;inset:0;background:rgba(0,0,0,.3)"></div>
        <div id="geo" role="dialog" style="position:fixed;top:30%;left:30%;background:#fff">
          Visiting from Netherlands? <button>Stay here</button></div>
        </body>`);
      await clearOverlays(page);
      for (const sel of ["#news", "#geo", "#wrap", "#veil"]) assert.equal(await shown(page, sel), false, `${sel} still shown`);
    });

    await t.test("hides a popup with no dialog role by the page it dims", async () => {
      // The two that survived the first version of this fix, measured live: satisfyrunning.com's
      // "Change Country?" (the dimming span sits two fixed layers down) and tracksmith.com's
      // "Visiting from Netherlands?" (an absolute dimming span). Neither has a role, neither
      // listens for Escape, and neither has a close button with a name.
      const satisfy = await open(`
        <body style="margin:0"><main style="height:3000px"><h1>Store</h1></main>
        <div id="country" style="position:fixed;inset:0;z-index:6666;display:flex;align-items:center;justify-content:center">
          <button style="position:fixed;inset:0;background:transparent;border:0"><span style="position:fixed;inset:0;background:rgba(0,0,0,.6)"></span></button>
          <div style="position:relative;z-index:10;background:#fff;padding:60px">Change Country?
            <select><option>Netherlands (EUR)</option></select> <button>Save</button></div>
        </div></body>`);
      await clearOverlays(satisfy);
      assert.equal(await shown(satisfy, "#country"), false);

      const tracksmith = await open(`
        <body style="margin:0"><main style="height:3000px"><h1>Store</h1></main>
        <div id="prompt" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999999">
          <span style="position:absolute;inset:0;background:rgba(0,0,0,.5)"></span>
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10;background:#fff;padding:40px">
            Visiting from Netherlands? <img alt="" width="80" height="80"></div>
        </div></body>`);
      await clearOverlays(tracksmith);
      assert.equal(await shown(tracksmith, "#prompt"), false);

      // The everyday Tailwind shape: the wrapper is the dimmer and holds the panel.
      const tailwind = await open(`
        <body style="margin:0"><main style="height:3000px"><h1>Store</h1></main>
        <div id="modal" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:grid;place-items:center">
          <div style="background:#fff;padding:40px">Get 10% off <input></div></div></body>`);
      await clearOverlays(tailwind);
      assert.equal(await shown(tailwind, "#modal"), false);

      // A backdrop that only blurs, with no tint at all.
      const frosted = await open(`
        <body style="margin:0"><main style="height:3000px"><h1>Store</h1></main>
        <div id="modal" style="position:fixed;inset:0;backdrop-filter:blur(8px);display:grid;place-items:center">
          <div style="background:#fff;padding:40px">Join the club</div></div></body>`);
      await clearOverlays(frosted);
      assert.equal(await shown(frosted, "#modal"), false);
    });

    await t.test("never hides what tints the page by design", async () => {
      // The commonest hero there is: a dark tint laid over the photo. It dims, it fills the screen,
      // and it must stay — it sits in the page's flow, where no popup lives.
      const hero = await open(`
        <body style="margin:0"><section style="position:relative;height:100vh;background:#456">
          <div id="tint" style="position:absolute;inset:0;background:rgba(0,0,0,.4)"></div>
          <h1 style="position:relative;margin:0;padding-top:40vh;color:#fff">Run further</h1></section>
        <main style="height:2000px">More</main></body>`);
      await clearOverlays(hero);
      assert.equal(await shown(hero, "#tint"), true);

      // A frosted-glass app shell: translucent and fixed, but it holds the page itself.
      const shell = await open(`
        <body style="margin:0;background:#8ab">
        <div id="shell" style="position:fixed;inset:0;overflow:auto;background:rgba(255,255,255,.7);backdrop-filter:blur(20px)">
          <main><h1 style="margin-top:45vh">App</h1></main></div></body>`);
      await clearOverlays(shell);
      assert.equal(await shown(shell, "#shell"), true);

      // A fixed portfolio wrapper with no main or h1, whose translucent sidebar is what sits at
      // the edge: a sidebar is not a dimmer, however translucent.
      const site = await open(`
        <body style="margin:0;background:#8ab">
        <div id="site" style="position:fixed;inset:0;overflow:auto">
          <nav style="position:absolute;left:0;top:0;bottom:0;width:240px;background:rgba(255,255,255,.6)">Menu</nav>
          <section style="margin-left:240px"><h2>Work</h2></section></div></body>`);
      await clearOverlays(site);
      assert.equal(await shown(site, "#site"), true);
    });

    await t.test("leaves page furniture alone", async () => {
      const page = await open(`
        <body style="margin:0">
        <video id="bg" style="position:fixed;inset:0;width:100%;height:100%;z-index:-1;background:#123"></video>
        <header id="hdr" style="position:sticky;top:0;height:60px;background:#111;color:#fff">Brand</header>
        <main style="height:3000px">
          <div id="demo" role="dialog" style="width:300px;padding:20px;border:1px solid">Dialog component demo</div></main>
        <canvas id="gl" style="position:fixed;inset:0;width:100vw;height:100vh"></canvas>
        <div id="wrap" style="position:fixed;inset:0;background:rgba(0,0,0,.5)">
          <div id="pop" role="dialog" aria-modal="true" style="margin:20vh auto;width:400px;background:#fff">Sign up</div></div>
        </body>`);
      await clearOverlays(page);
      assert.equal(await shown(page, "#pop"), false);
      assert.equal(await shown(page, "#wrap"), false);
      // A sticky header, a background video, an in-flow dialog demo and a full-screen WebGL
      // canvas are the design, not overlays.
      for (const sel of ["#hdr", "#bg", "#demo", "#gl"]) assert.equal(await shown(page, sel), true, `${sel} was hidden`);
    });

    await t.test("never takes a full-screen app shell or 3D viewer for a backdrop", async () => {
      // A site whose whole content is a fixed, full-viewport scroller: hiding it blanks the page.
      const shell = await open(`
        <body style="margin:0">
        <div id="shell" style="position:fixed;inset:0;overflow:auto"><h1 style="margin-top:45vh">App</h1></div>
        <div id="veil" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"></div>
        <div id="pop" role="dialog" style="position:fixed;top:10px;left:10px;background:#fff">Hi</div>
        </body>`);
      await clearOverlays(shell);
      assert.equal(await shown(shell, "#veil"), false);
      assert.equal(await shown(shell, "#shell"), true);

      // 3D viewers render into a shadow root, where their canvas looks empty to innerText and
      // querySelector: one as a custom element (Spline, model-viewer), one as a plain host div.
      const viewers = await open(`
        <body style="margin:0"><main style="height:3000px">Page</main>
        <x-scene id="scene" style="position:fixed;inset:0;display:block"></x-scene>
        <div id="pop" role="dialog" style="position:fixed;top:10px;left:10px;background:#fff">Hi</div></body>`);
      await clearOverlays(viewers);
      assert.equal(await shown(viewers, "#pop"), false);
      assert.equal(await shown(viewers, "#scene"), true);

      const host = await open(`
        <body style="margin:0"><main style="height:3000px">Page</main>
        <div id="viewer" style="position:fixed;inset:0"></div>
        <div id="pop" role="dialog" style="position:fixed;top:10px;left:10px;background:#fff">Hi</div>
        <script>document.getElementById("viewer").attachShadow({ mode: "open" }).innerHTML =
          '<canvas style="width:100vw;height:100vh"></canvas>';</script></body>`);
      await clearOverlays(host);
      assert.equal(await shown(host, "#pop"), false);
      assert.equal(await shown(host, "#viewer"), true);

      const video = await open(`
        <body style="margin:0"><main style="height:3000px">Page</main>
        <div id="hero" style="position:fixed;inset:0"><video muted style="width:100%;height:100%;background:#123"></video></div>
        <div id="pop" role="dialog" style="position:fixed;top:10px;left:10px;background:#fff">Hi</div></body>`);
      await clearOverlays(video);
      assert.equal(await shown(video, "#pop"), false);
      assert.equal(await shown(video, "#hero"), true);
    });
  } finally {
    await browser.close();
  }
});

/** Whether any pixel in the PNG is exactly this colour. */
async function hasColor(file: string, [r, g, b]: [number, number, number]): Promise<boolean> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] === r && data[i + 1] === g && data[i + 2] === b) return true;
  }
  return false;
}

test("captureWeb clears a consent banner from the desktop and the mobile pass", async () => {
  // The banditrunning.com shape: Shopify's own banner, which no cookie/consent selector matched,
  // so it sat over the desktop fold and covered most of the mobile capture.
  tempDataDir();
  const slug = await captureWeb(`${base}consent.html`);
  const dir = designDir(slug);
  for (const f of ["desktop-fold.png", "desktop.png", "mobile.png"]) {
    assert.equal(await hasColor(path.join(dir, f), [255, 0, 255]), false, `consent banner is in ${f}`);
  }
  assert.equal(readMeta(slug).status, "needs-analysis");
});

test("the fold is shot from the top even when the page scrolls smoothly", async () => {
  tempDataDir();
  const slug = await captureWeb(`${base}smooth.html`);
  const { data } = await sharp(path.join(designDir(slug), "desktop-fold.png"))
    .extract({ left: 5, top: 5, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray(0, 3)], [10, 37, 64], "the fold should open on the header (#0a2540)");
});
