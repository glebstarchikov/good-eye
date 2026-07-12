import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { Vibrant } from "node-vibrant/node";
import { designDir, ensureDir, makeSlug } from "../lib/paths.js";
import { MetaSchema, domainFromUrl, writeMeta, type Meta } from "../lib/meta.js";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

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

  const browser = await chromium.launch();
  let status: Meta["status"] = "needs-analysis";
  const degrade = () => { status = "partial"; };
  try {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!resp || resp.status() >= 400) {
      throw new Error(`Failed to load ${url}: HTTP ${resp ? resp.status() : "no response"}`);
    }
    ensureDir(dir); // only after a successful load — hard failures create no entry

    let title = "";
    let components: Meta["components"] = [];
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(degrade);
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
        await mpage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
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
        note: opts.note ?? "", tags: [], palette: [], typography: {}, components, screens: [],
      });
      writeMeta(meta);
      return slug;
    } catch (err) {
      if (salvageOrCleanup(dir, { slug, url, domain, note: opts.note ?? "", title, components })) {
        console.error(`good-eye: capture degraded for ${slug}, saved as partial: ${err instanceof Error ? err.message : err}`);
        return slug;
      }
      throw err;
    }
  } finally {
    await browser.close();
  }
}
