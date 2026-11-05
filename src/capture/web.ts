import fs from "node:fs";
import path from "node:path";
import { chromium, type Page, type Request, type Response } from "playwright";
import { Vibrant } from "node-vibrant/node";
import { designDir, ensureDir, makeSlug } from "../lib/paths.js";
import { MetaSchema, domainFromUrl, writeMeta, type Meta } from "../lib/meta.js";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

/** Budget for the server to return response headers. A reachable host commits in ~1s; this only
 * runs long for a genuinely dead one. Overridable on the same grounds as the DOM budget below. */
const navTimeoutMs = () => Number(process.env.GOOD_EYE_NAV_TIMEOUT_MS) || 30000;
/**
 * How long to let a *parsed* document withhold DOMContentLoaded before blaming a deferred script.
 *
 * Not shorter than the 30s this module's `goto` used to allow, deliberately. The old code waited
 * the full 30s for the event and then failed; anything under that here would take a required
 * bundle that merely downloads slowly, abort it as dead, and reload without it — turning a page
 * the previous version loaded perfectly into a silently unhydrated capture. Recovery must never be
 * reachable in less time than the old path took to succeed.
 */
const domTimeoutMs = () => Number(process.env.GOOD_EYE_DOM_TIMEOUT_MS) || 30000;
/** How long to let a document that is *still parsing* keep going before calling it blocked. More
 * patient again, because the two stalls carry different costs: a document stuck at readyState
 * "loading" can simply be a slow origin — fourseasons.com genuinely takes 32s to reach
 * DOMContentLoaded — and calling that blocked costs the user a capture, whereas waiting only costs
 * time on a page that was failing anyway. Independent of the budget above rather than a multiple
 * of it, so tuning one can't silently move the other. */
const parseTimeoutMs = () => Number(process.env.GOOD_EYE_PARSE_TIMEOUT_MS) || 45000;

/** A challenge is identified by plumbing that is *live in the document* — a loaded challenge
 * script, or the container it renders into. Deliberately not a substring scan of the serialized
 * HTML: a page that merely writes `/cdn-cgi/challenge-platform/` in prose or a config sample is a
 * normal page, and this library captures developer-tool sites that plausibly do exactly that.
 * Matching text would refuse them outright, retry included. Same reasoning that keeps the
 * "Just a moment…" title out of this list — prose can imitate a challenge, structure cannot. */
const CHALLENGE_SELECTORS = [
  'script[src*="/cdn-cgi/challenge-platform/"]',
  "#challenge-running",
  "#cf-challenge-running",
  "#challenge-error-title",
  '[id^="cf-chl"]',
  '[class*="cf-browser-verification"]',
].join(", ");

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

/**
 * Abort a routed request, but only when it really is the script we meant to drop.
 *
 * Routes match on URL alone, and a URL is not owned by one resource type: the same address can
 * serve a script and an image or fetch that varies on Sec-Fetch-Dest, and could even be the
 * document itself. Aborting all of them would strip healthy media from the very capture this
 * recovery exists to rescue, or fail the navigation outright as "unreachable".
 */
const dropScript = (route: { request(): Request; abort(): Promise<void>; continue(): Promise<void> }) =>
  route.request().resourceType() === "script" ? route.abort() : route.continue();

/** How long to give an in-page probe before assuming the renderer can't answer. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Ask the page a question, bounded.
 *
 * page.evaluate takes no timeout of its own, and a page spinning its main thread never gets around
 * to running it — so an unbounded probe would hang the whole capture with no timeout to end it,
 * strictly worse than the failure this module exists to fix. A page too busy to answer is treated
 * as the pessimistic case, which is what `fallback` carries.
 */
async function probe<T, A>(page: Page, fn: (arg: A) => T, fallback: T, arg?: A): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(fn as (a: unknown) => T, arg).catch(() => fallback),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer); // or a pending timer keeps the event loop alive after we've answered
  }
}

/**
 * Navigate (or reload) and classify the outcome. Both entry points share this so a failure is
 * described the same way wherever it happened: an unclassified Playwright error escaping from the
 * reload would bypass captureWeb's real-browser retry and land the user back at a bare timeout,
 * which is the failure this module exists to remove.
 */
async function navigate(page: Page, url: string, go: () => Promise<Response | null>, when = ""): Promise<number> {
  let resp: Response | null;
  try {
    resp = await go();
  } catch (err) {
    throw new CaptureError(
      "unreachable",
      `${url} sent no HTTP response within ${navTimeoutMs() / 1000}s${when} — the host is down, ` +
        `DNS is failing, or the network is blocking it. (${firstLine(err)})`
    );
  }
  if (!resp) throw new CaptureError("unreachable", `${url} produced no HTTP response${when}.`);

  const status = resp.status();
  if (status < 400) return status;

  // 403 is refusal of the client itself, and a real browser is frequently served the page instead.
  // Measured on fourseasons.com and passalacqua.it — both 403 headless, both 200 in headed Chrome.
  if (status === 403) {
    throw new CaptureError(
      "blocked",
      `${url} returned HTTP 403${when} — the site is refusing automated browsers outright, before ` +
        `any page is served. Retry in a real browser, or capture by hand.`
    );
  }
  // A WAF often serves its interstitial *with* an error status — 503 and 429 are both common — so
  // the body has to be examined before the status is taken at face value. Filing that as a plain
  // http-error would deny it the retry that is exactly what it needs. Error pages are tiny and
  // parse immediately, so the wait costs an ordinary 404 nothing measurable.
  await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
  if (await looksChallenged(page)) {
    throw new CaptureError(
      "blocked",
      `${url} returned HTTP ${status}${when}, but the body is a bot challenge rather than an ` +
        `error page. Retry in a real browser, or capture by hand.`
    );
  }
  throw new CaptureError("http-error", `Failed to load ${url}: HTTP ${status}${when}`);
}

export async function looksChallenged(page: Page): Promise<boolean> {
  return probe(page, (sel: string) => !!document.querySelector(sel), false, CHALLENGE_SELECTORS);
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
  for (const u of blocked) await page.route(u, dropScript);

  // Only scripts can withhold DOMContentLoaded while leaving the DOM parsed: a *sync* script stalls
  // the parser itself (readyState stays "loading", handled below), and non-script subresources
  // don't gate the event at all. So this is the complete set of abort candidates, and images or
  // XHRs still in flight are left alone.
  //
  // Each pending request is stored with its full redirect chain, because the URL that stalls is
  // often not the one the reload will ask for. A gating script that 302s before hanging leaves the
  // *target* pending, so blocking only that does nothing — the reload re-requests the original and
  // follows the redirect again, since a route is matched when the request is issued and not
  // re-consulted for the hop. Blocking every URL in the chain stops it at the first link.
  // Keyed by the Request object, not its URL: two concurrent requests can share a URL, and keying
  // by string collapses them — the one that completes then deletes the entry belonging to the one
  // still hanging, and recovery is skipped for a page it could have fixed. Playwright hands back
  // the same Request instance on every event, so identity is the reliable key.
  const pendingScripts = new Map<Request, string[]>();
  page.on("request", (r) => {
    if (r.resourceType() !== "script") return;
    const chain: string[] = [];
    for (let hop: Request | null = r; hop; hop = hop.redirectedFrom()) chain.push(hop.url());
    pendingScripts.set(r, chain);
  });
  const settle = (r: Request) => { pendingScripts.delete(r); };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);

  const status = await navigate(page, url, () =>
    page.goto(url, { waitUntil: "commit", timeout: navTimeoutMs() }));

  const reachedDom = (ms: number) =>
    page.waitForLoadState("domcontentloaded", { timeout: ms }).then(() => true, () => false);
  // readyState tells the two stalls apart: it leaves "loading" the moment the parser finishes,
  // which is *before* deferred scripts run. Still "loading" => the document itself is still
  // arriving. Past it => the document is complete and only a deferred script is outstanding.
  const stillParsing = async () => (await probe(page, () => document.readyState, "loading")) === "loading";

  let ok = await reachedDom(domTimeoutMs());
  // A document still mid-parse has earned more patience than a stalled deferred script has.
  if (!ok && (await stillParsing())) ok = await reachedDom(Math.max(0, parseTimeoutMs() - domTimeoutMs()));

  if (!ok) {
    // Name the gating script when we can, for the log line only. Note what counts as gating — a
    // module script is deferred *by default*, so it gates the event even though
    // HTMLScriptElement.defer reads false for it (that property reflects an attribute modules
    // don't set). Filtering on `defer` alone would miss the very script that motivated this fix:
    // the Cloudflare beacon ships as type="module".
    //
    // Recovery deliberately does NOT hinge on matching one of these to a pending URL. The request
    // that actually stalls is often not the one written in the DOM — a gating script can redirect
    // before stalling, and a module that downloads fine can have a stalled import several levels
    // down the graph. In both cases an exact-URL intersection comes back empty and we would refuse
    // to recover from a page we can plainly fix, so an outstanding script request is enough.
    const gating = await probe(page, () =>
      Array.from(document.querySelectorAll("script[src]"))
        .filter((el) => {
          const s = el as HTMLScriptElement;
          return s.async ? false : s.type === "module" || s.defer;
        })
        .map((el) => (el as HTMLScriptElement).src), [] as string[]);
    const chains = [...pendingScripts.values()];
    const blame = chains.flat().filter((u) => gating.includes(u));
    // But abort *every* outstanding script, not just the one to blame. A non-gating script left
    // hanging still keeps the load event — and with it document.fonts.ready — from ever firing,
    // and page.screenshot() waits on that unconditionally: measured, sparing one costs the whole
    // capture rather than that one script. Nothing healthy is caught, because anything still
    // pending after the full budget has already proven dead.
    const stalled = [...new Set(chains.flat())];

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
          `${domTimeoutMs() / 1000}s with no outstanding script request to drop. Capture by hand.`
      );
    }

    // Waiting out the full budget before doing this is the safeguard, not an oversight: a real
    // deferred bundle on a slow link must be given time to arrive, because aborting one would
    // leave the page unhydrated and quietly capture a broken screenshot.
    console.error(
      `good-eye: ${url} — DOMContentLoaded is blocked by ${blame.join(", ") || "a stalled script"}; ` +
        `dropping ${stalled.length} dead script request(s) and reloading`
    );
    for (const u of stalled) {
      blocked.add(u);
      await page.route(u, dropScript);
    }
    // The reload gets the same scrutiny as the first navigation, rejections included: a raw
    // Playwright error escaping here would skip captureWeb's real-browser retry and land the user
    // right back at the bare timeout this module exists to remove.
    await navigate(page, url, () => page.reload({ waitUntil: "commit", timeout: navTimeoutMs() }), " on reload");
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

/** A consent button, matched on its whole accessible name. Not "the first button in anything named
 * cookie": on openai.com that was "Manage Cookies", and its modal became the capture. Anchored,
 * so an "Accept invitation" call to action never qualifies. English, Dutch and German, the languages
 * these captures are actually served in. */
const CONSENT_NAME = new RegExp(`^\\s*(${[
  "accept", "accept all", "accept all cookies", "accept cookies", "allow all", "allow all cookies",
  "allow cookies", "agree", "i agree", "i accept", "got it",
  "accepteren", "alles accepteren", "alle cookies accepteren", "akkoord", "toestaan", "alles toestaan",
  "akzeptieren", "alle akzeptieren", "alle cookies akzeptieren", "zustimmen", "alle zulassen", "einverstanden",
].join("|")})[.!]?\\s*$`, "i");

/**
 * Hide the dialogs still floating over the page, then any popup that dims it. Runs in the page, so
 * no named inner functions (see autoScroll).
 *
 * A dialog only counts when it, or something it sits in, is position: fixed. An in-flow dialog is
 * part of the page: component libraries demo theirs inline.
 *
 * Most popups carry no dialog role at all — the store geo prompts on satisfyrunning.com and
 * tracksmith.com don't — so the second pass keys on what every modal does instead: it greys the
 * page out. Whatever sits near the left edge is checked for a full-viewport, semi-transparent layer;
 * finding one, the outermost fixed full-viewport layer around it goes, so the panel goes with its
 * dimmer. A canvas, a video or a 3D viewer is opaque or clear, never tinted, so none qualifies. And
 * the climb stops before anything holding the page itself (main, h1), so a frosted-glass app shell
 * is never taken for a backdrop.
 */
function hideOverlays(): void {
  const dialogs = document.querySelectorAll<HTMLElement>(
    'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'
  );
  for (const el of Array.from(dialogs)) {
    if (!el.checkVisibility({ visibilityProperty: true })) continue;
    let floating = false;
    for (let a: Element | null = el; a && !floating; a = a.parentElement) {
      floating = getComputedStyle(a).position === "fixed";
    }
    if (floating) el.style.setProperty("display", "none", "important");
  }

  for (let i = 0; i < 5; i++) { // popups stack when two open at once
    let dimmer: HTMLElement | null = null;
    let a = document.elementFromPoint(innerWidth * 0.03, innerHeight / 2) as HTMLElement | null;
    for (; a && a !== document.body && a !== document.documentElement && !dimmer; a = a.parentElement) {
      const s = getComputedStyle(a);
      const r = a.getBoundingClientRect();
      // rgba(r, g, b, a) or the slash form, e.g. oklab(0 0 0 / 0.5) from Tailwind 4
      const m = s.backgroundColor.match(/^rgba\(.*,\s*([\d.]+)\)$|\/\s*([\d.]+)(%?)\s*\)$/);
      const alpha = (m ? parseFloat(m[1] ?? m[2]) / (m[3] ? 100 : 1) : 1) * parseFloat(s.opacity);
      const tinted = (alpha > 0 && alpha < 1) || s.backdropFilter !== "none";
      if (tinted && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9) dimmer = a;
    }
    let popup: HTMLElement | null = null;
    for (a = dimmer; a && a !== document.body && !a.querySelector("main, h1"); a = a.parentElement) {
      const r = a.getBoundingClientRect();
      if (getComputedStyle(a).position === "fixed" && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9) popup = a;
    }
    if (!popup) break;
    popup.style.setProperty("display", "none", "important");
  }
}

/** Clear what floats over the page before it is photographed, in order of how much each step can be
 * trusted: answer a consent banner the way a visitor would, press Escape for popups that listen for
 * it, and only then hide whatever is still up. */
export async function clearOverlays(page: Page): Promise<void> {
  try {
    const consent = page.getByRole("button", { name: CONSENT_NAME })
      .or(page.locator("#onetrust-accept-btn-handler"))
      .filter({ visible: true })
      .first();
    if (await consent.count()) {
      await consent.click({ timeout: 1000 });
      await page.waitForTimeout(500); // let the banner animate out
    }
  } catch { /* best effort per spec §4 */ }
  await page.keyboard.press("Escape").catch(() => {});
  await probe(page, hideOverlays, undefined);
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
          // instant: under scroll-behavior: smooth the trip back up takes seconds, and the fold
          // screenshot catches it halfway (satisfyrunning.com)
          window.scrollTo({ top: 0, behavior: "instant" });
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
    // Recovery is not free, so say so on the entry rather than letting a page that lost a script
    // read as a pristine capture. The requests dropped here had all gone quiet for the full
    // budget, but "almost certainly dead" is still worth recording next to the screenshots.
    const note = stalledScripts.length
      ? `${entry.note ? `${entry.note} — ` : ""}captured after dropping ` +
        `${stalledScripts.length} dead script request(s): ${stalledScripts.join(", ")}`
      : entry.note;
    ensureDir(dir); // only after a successful load — hard failures create no entry

    let title = "";
    let components: Meta["components"] = [];
    try {
      // Best-effort settle. Analytics-heavy sites never go network-idle, and autoScroll
      // below is what actually triggers lazy-load — so a timeout here is normal, NOT a
      // degrade. Partial is reserved for a genuinely missing artifact (e.g. the mobile pass).
      await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      await clearOverlays(page);
      await autoScroll(page);
      await clearOverlays(page); // newsletter popups wait for a timer or a scroll depth

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
        await clearOverlays(mpage); // a fresh context, so the banner is back
        await autoScroll(mpage);
        await clearOverlays(mpage);
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
        note, tags: [], palette: [], typography: {}, components, screens: [],
      });
      writeMeta(meta);
      return slug;
    } catch (err) {
      if (salvageOrCleanup(dir, { slug, url, domain, note, title, components })) {
        console.error(`good-eye: capture degraded for ${slug}, saved as partial: ${err instanceof Error ? err.message : err}`);
        return slug;
      }
      throw err;
    }
  } finally {
    await browser.close();
  }
}
