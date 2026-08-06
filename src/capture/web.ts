import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { Vibrant } from "node-vibrant/node";
import { designDir, ensureDir, makeSlug } from "../lib/paths.js";
import { MetaSchema, domainFromUrl, writeMeta, type Meta } from "../lib/meta.js";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

/** Budget for the server to return response headers. A reachable host commits in ~1s; this only
 * runs long for a genuinely dead one. */
const NAV_TIMEOUT_MS = 30000;
/** How long to let a *parsed* document withhold DOMContentLoaded before blaming a deferred script.
 * Overridable so the tests can exercise the stall paths without burning 15s apiece; also a genuine
 * escape hatch on a slow link. Read per call, not at import, so a test can set it after loading. */
const domTimeoutMs = () => Number(process.env.GOOD_EYE_DOM_TIMEOUT_MS) || 15000;
/** How long to let a document that is *still parsing* keep going before calling it blocked. Much
 * more patient, because the two stalls carry very different costs: a document stuck at readyState
 * "loading" can simply be a slow origin — fourseasons.com genuinely takes 32s to reach
 * DOMContentLoaded — and calling that blocked costs the user a capture, whereas waiting only costs
 * time on a page that was failing anyway. */
const parseTimeoutMs = () => domTimeoutMs() * 3;

/** Cloudflare interstitials parse and fire DOMContentLoaded perfectly well — they're ordinary HTML
 * pages. Only their markup gives them away. Match on the challenge plumbing rather than on the
 * "Just a moment…" title, so a page that merely uses that phrase in its copy can't trip this. */
const CHALLENGE_MARKERS = [
  "/cdn-cgi/challenge-platform/",
  "__cf_chl_",
  "cf-browser-verification",
  "cf_chl_opt",
];

export type CaptureFailureKind =
  | "unreachable"  // no HTTP response at all — dead host, DNS, or a network-level block
  | "http-error"   // the server answered, with 4xx/5xx
  | "blocked";     // answered 200, but served a challenge or never finished parsing

/** Carries *why* a capture failed so the caller can act: only "blocked" is worth a real-browser retry. */
export class CaptureError extends Error {
  constructor(readonly kind: CaptureFailureKind, message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

const firstLine = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).split("\n")[0];

export async function looksChallenged(page: Page): Promise<boolean> {
  const html = await page.content().catch(() => "");
  return CHALLENGE_MARKERS.some((m) => html.includes(m));
}

/**
 * Navigate and wait for a DOM we can actually screenshot, classifying every failure mode.
 *
 * Why not `goto(url, { waitUntil: "domcontentloaded" })` — the obvious spelling, and what this used
 * to do: per the HTML spec's "end of parsing" steps, DOMContentLoaded fires only *after* every
 * `<script defer>` has executed. A single deferred script whose request never settles — a
 * DNS-blackholed analytics beacon is the common case — therefore withholds the event indefinitely,
 * even though the parser finished and the full DOM is sitting right there. `goto` then burns its
 * whole timeout and throws, so a perfectly capturable page reads as a dead one.
 *
 * So: commit first (response headers only — this is what separates a dead host from a stalled one),
 * then, if the event doesn't arrive, abort the stalled script and reload. Coping with the pinned
 * document instead is not enough: page.screenshot() unconditionally awaits document.fonts.ready,
 * which Chrome never settles on a document that never finishes loading, and Playwright exposes no
 * option to skip that wait — so the same hang just resurfaces on every screenshot. Dropping the
 * request lets the deferred queue drain, and the reloaded page is healthy by every measure.
 *
 * `preBlock` carries URLs a previous pass already found stalled, so the mobile pass doesn't pay the
 * detection budget over again. Returns everything blocked, for the next pass to reuse.
 */
export async function gotoReady(page: Page, url: string, preBlock: string[] = []): Promise<string[]> {
  const blocked = new Set(preBlock);
  for (const u of blocked) await page.route(u, (r) => r.abort());

  // Only scripts can withhold DOMContentLoaded while leaving the DOM parsed: a *sync* script stalls
  // the parser itself (readyState stays "loading", handled below), and non-script subresources
  // don't gate the event at all. So this is the complete set of abort candidates, and images or
  // XHRs still in flight are left alone.
  const pendingScripts = new Set<string>();
  page.on("request", (r) => { if (r.resourceType() === "script") pendingScripts.add(r.url()); });
  const settle = (r: { url(): string }) => { pendingScripts.delete(r.url()); };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);

  let resp;
  try {
    resp = await page.goto(url, { waitUntil: "commit", timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    throw new CaptureError(
      "unreachable",
      `${url} sent no HTTP response within ${NAV_TIMEOUT_MS / 1000}s — the host is down, DNS is ` +
        `failing, or the network is blocking it. (${firstLine(err)})`
    );
  }
  if (!resp) throw new CaptureError("unreachable", `${url} produced no HTTP response.`);
  const status = resp.status();
  // 403 is the one status worth a second attempt: it's how an edge WAF refuses an automated
  // client outright, and a real browser is frequently served the page instead. Measured on
  // fourseasons.com and passalacqua.it — both 403 headless, both 200 in headed Chrome.
  if (status === 403) {
    throw new CaptureError(
      "blocked",
      `${url} returned HTTP 403 — the site is refusing automated browsers outright, before any ` +
        `page is served. Retry in a real browser, or capture by hand.`
    );
  }
  if (status >= 400) {
    throw new CaptureError("http-error", `Failed to load ${url}: HTTP ${status}`);
  }

  const reachedDom = (ms: number) =>
    page.waitForLoadState("domcontentloaded", { timeout: ms }).then(() => true, () => false);
  // readyState tells the two stalls apart: it leaves "loading" the moment the parser finishes,
  // which is *before* deferred scripts run. Still "loading" => the document itself is still
  // arriving. Past it => the document is complete and only a deferred script is outstanding.
  const stillParsing = async () =>
    (await page.evaluate(() => document.readyState).catch(() => "loading")) === "loading";

  let ok = await reachedDom(domTimeoutMs());
  // A document still mid-parse has earned more patience than a stalled deferred script has.
  if (!ok && (await stillParsing())) ok = await reachedDom(parseTimeoutMs() - domTimeoutMs());

  if (!ok) {
    const stalled = [...pendingScripts];
    if (await stillParsing()) {
      throw new CaptureError(
        "blocked",
        `${url} answered HTTP ${status} but never finished parsing within ` +
          `${parseTimeoutMs() / 1000}s — the response stalls mid-document, which is what a bot ` +
          `challenge or interstitial looks like. Retry in a real browser, or capture by hand.`
      );
    }
    if (!stalled.length) {
      throw new CaptureError(
        "blocked",
        `${url} answered HTTP ${status} and parsed, but never fired DOMContentLoaded within ` +
          `${domTimeoutMs() / 1000}s with no outstanding script to blame. Capture by hand.`
      );
    }

    // Waiting out the full budget before doing this is the safeguard, not an oversight: a real
    // deferred bundle on a slow link must be given time to arrive, because aborting one would
    // leave the page unhydrated and quietly capture a broken screenshot.
    console.error(
      `good-eye: ${url} — DOMContentLoaded is blocked by ${stalled.length} stalled script(s); ` +
        `dropping them and reloading: ${stalled.join(", ")}`
    );
    for (const u of stalled) {
      blocked.add(u);
      await page.route(u, (r) => r.abort());
    }
    await page.reload({ waitUntil: "commit", timeout: NAV_TIMEOUT_MS });
    if (!(await reachedDom(parseTimeoutMs()))) {
      throw new CaptureError(
        "blocked",
        `${url} answered HTTP ${status}, but its document never completed even after dropping ` +
          `the stalled script(s). Retry in a real browser, or capture by hand.`
      );
    }
  }

  if (await looksChallenged(page)) {
    throw new CaptureError(
      "blocked",
      `${url} answered HTTP ${status} but served a bot challenge instead of the site. ` +
        `Retry in a real browser, or capture by hand.`
    );
  }
  return [...blocked];
}

// One combined selector: querySelectorAll dedupes elements matching multiple parts.
const SECTION_SELECTOR = [
  "header", "nav", "footer", "main > section", "body > section",
  "[class*=hero]", "[class*=pricing]", "[class*=testimonial]", "[class*=faq]",
].join(", ");

const COOKIE_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "[id*=cookie i] button",
  "[class*=cookie i] button",
  "[class*=consent i] button",
];

async function dismissCookieBanners(page: Page): Promise<void> {
  for (const sel of COOKIE_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 300 })) await el.click({ timeout: 1000 });
    } catch { /* best effort per spec §4 */ }
  }
}

async function autoScroll(page: Page): Promise<void> {
  // Note: no named inner function/const here — tsx's esbuild transform (keepNames)
  // wraps named closures in a module-scope __name() helper for debug-friendly stack
  // traces. Playwright serializes this callback via toString() to run in the browser
  // context, where that helper doesn't exist, so a named `step` closure throws
  // "ReferenceError: __name is not defined". setInterval keeps this anonymous.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 600);
        total += 600;
        if (total >= document.body.scrollHeight || total > 30000) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 120);
    });
  });
  await page.waitForTimeout(400); // let lazy images settle
}

async function captureSections(page: Page, dir: string): Promise<Meta["components"]> {
  ensureDir(path.join(dir, "components"));
  const handles = await page.$$(SECTION_SELECTOR);
  const components: Meta["components"] = [];
  let i = 0;
  for (const h of handles) {
    if (components.length >= 15) break;
    try {
      const box = await h.boundingBox();
      if (!box || box.height < 100 || box.width < 200) continue;
      const rel = path.join("components", `section-${i}.png`);
      await h.screenshot({ path: path.join(dir, rel) });
      components.push({ type: "other", path: rel, description: "" });
      i++;
    } catch { /* detached/hidden elements are skippable */ }
  }
  return components;
}

async function collectCss(page: Page): Promise<string> {
  return page.evaluate(() => {
    let out = "";
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) out += rule.cssText + "\n";
      } catch { /* cross-origin sheets are unreadable; skip silently per spec */ }
    }
    return out;
  });
}

async function extractDeclaredTokens(page: Page) {
  return page.evaluate(() => {
    const cssVars: Record<string, string> = {};
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSStyleRule && rule.selectorText === ":root") {
            for (const name of Array.from(rule.style)) {
              if (name.startsWith("--")) cssVars[name] = rule.style.getPropertyValue(name).trim();
            }
          }
        }
      } catch { /* cross-origin */ }
    }
    const fonts = new Set<string>();
    const sizes = new Set<string>();
    document.querySelectorAll("h1,h2,h3,p,a,button,body").forEach((el) => {
      const cs = getComputedStyle(el);
      fonts.add(cs.fontFamily.split(",")[0].trim().replace(/['"]/g, ""));
      sizes.add(cs.fontSize);
    });
    return {
      cssVars,
      fonts: [...fonts],
      fontSizes: [...sizes].sort((a, b) => parseFloat(a) - parseFloat(b)),
    };
  });
}

async function empiricalPalette(imagePath: string) {
  const palette = await Vibrant.from(imagePath).getPalette();
  return Object.entries(palette)
    .filter(([, swatch]) => swatch)
    .map(([name, swatch]) => ({ name, hex: swatch!.hex, population: swatch!.population }));
}

/** Called on any throw after ensureDir(dir) inside captureWeb (spec §4: a partial capture saves what
 * it got, marked "partial"). If a full-page or above-the-fold screenshot made it to disk, that's worth
 * keeping — write a provisional meta.json with whatever fields are known so analyze() can still run on
 * it later. Otherwise there's nothing salvageable, so remove the empty dir rather than strand it. */
export function salvageOrCleanup(dir: string, fields: {
  slug: string; url: string; domain: string; note: string; title?: string; components?: Meta["components"];
}): boolean {
  const hasScreenshot = fs.existsSync(path.join(dir, "desktop-fold.png")) || fs.existsSync(path.join(dir, "desktop.png"));
  if (!hasScreenshot) {
    fs.rmSync(dir, { recursive: true, force: true });
    return false;
  }
  const meta = MetaSchema.parse({
    slug: fields.slug, source_type: "web", platform: "web", url: fields.url, domain: fields.domain,
    title: fields.title ?? "", category: "other", status: "partial", captured_at: new Date().toISOString(),
    note: fields.note, tags: [], palette: [], typography: {}, components: fields.components ?? [], screens: [],
  });
  writeMeta(meta);
  return true;
}

export async function captureWeb(url: string, opts: { note?: string; force?: boolean } = {}): Promise<string> {
  const domain = domainFromUrl(url);
  const slug = makeSlug(domain);
  const dir = designDir(slug);
  if (fs.existsSync(dir)) {
    if (!opts.force) throw new Error(`Entry "${slug}" already exists for today; pass force to re-capture`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  try {
    return await runCapture(url, { slug, dir, domain, note: opts.note ?? "" }, {});
  } catch (err) {
    // Only a challenge is worth a second attempt. Everything else (dead host, 404, a stalled
    // deferred script we already captured through) would fail identically and just burn a minute.
    if (!(err instanceof CaptureError) || err.kind !== "blocked") throw err;
    console.error(`good-eye: ${url} looks challenged; retrying once in a real browser…`);
    try {
      return await runCapture(url, { slug, dir, domain, note: opts.note ?? "" }, REAL_BROWSER);
    } catch (retryErr) {
      // Compare the message, not just the kind: a retry that gets past a 403 only to hit a consent
      // wall is also "blocked", and reporting that as "the same wall" would hide the real reason.
      const detail = retryErr instanceof CaptureError && retryErr.message === err.message
        ? "A real browser hit the same wall, so this one needs capturing by hand."
        : `The real-browser retry got further, then failed: ${firstLine(retryErr)}`;
      throw new CaptureError("blocked", `${err.message}\n${detail}`);
    }
  }
}

/** A headed, real-Chrome launch: the profile a challenge is most likely to wave through. Falls over
 * with a clear launch error if Chrome isn't installed, which captureWeb folds into its message. */
const REAL_BROWSER = { channel: "chrome", headless: false } as const;

async function runCapture(
  url: string,
  entry: { slug: string; dir: string; domain: string; note: string },
  launchOpts: Parameters<typeof chromium.launch>[0]
): Promise<string> {
  const { slug, dir, domain } = entry;
  const browser = await chromium.launch(launchOpts);
  let status: Meta["status"] = "needs-analysis";
  const degrade = () => { status = "partial"; };
  try {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();
    const stalledScripts = await gotoReady(page, url);
    ensureDir(dir); // only after a successful load — hard failures create no entry

    let title = "";
    let components: Meta["components"] = [];
    try {
      // Best-effort settle. Analytics-heavy sites never go network-idle, and autoScroll
      // below is what actually triggers lazy-load — so a timeout here is normal, NOT a
      // degrade. Partial is reserved for a genuinely missing artifact (e.g. the mobile pass).
      await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      await dismissCookieBanners(page);
      await autoScroll(page);

      await page.screenshot({ path: path.join(dir, "desktop-fold.png") }); // viewport = above the fold
      await page.screenshot({ path: path.join(dir, "desktop.png"), fullPage: true });
      components = await captureSections(page, dir);

      title = await page.title();
      fs.writeFileSync(path.join(dir, "page.html"), await page.content());
      fs.writeFileSync(path.join(dir, "styles.css"), await collectCss(page));
      const declared = await extractDeclaredTokens(page);
      await ctx.close();

      // Mobile pass — degradation, not failure, if it breaks.
      try {
        const mctx = await browser.newContext({ viewport: MOBILE });
        const mpage = await mctx.newPage();
        // Same wait semantics, or a stalled script would force "partial" — and reusing what the
        // desktop pass already found spares this one the whole detection budget again.
        await gotoReady(mpage, url, stalledScripts);
        await autoScroll(mpage);
        await mpage.screenshot({ path: path.join(dir, "mobile.png"), fullPage: true });
        await mctx.close();
      } catch { degrade(); }

      const palette = await empiricalPalette(path.join(dir, "desktop-fold.png"));
      fs.writeFileSync(
        path.join(dir, "tokens.json"),
        JSON.stringify({ declared, empiricalPalette: palette }, null, 2)
      );

      const meta = MetaSchema.parse({
        slug, source_type: "web", platform: "web", url, domain, title,
        category: "other", status, captured_at: new Date().toISOString(),
        note: entry.note, tags: [], palette: [], typography: {}, components, screens: [],
      });
      writeMeta(meta);
      return slug;
    } catch (err) {
      if (salvageOrCleanup(dir, { slug, url, domain, note: entry.note, title, components })) {
        console.error(`good-eye: capture degraded for ${slug}, saved as partial: ${err instanceof Error ? err.message : err}`);
        return slug;
      }
      throw err;
    }
  } finally {
    await browser.close();
  }
}
