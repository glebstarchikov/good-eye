import { captureWeb } from "./capture/web.js";
import { ingestAppStore, ingestFolder, isStoreUrl } from "./capture/app.js";
import { analyze } from "./librarian/analyze.js";
import { openDb, reindexAll, searchDesigns, listTagCounts } from "./lib/db.js";

type Parsed = { positional: string[]; flags: Record<string, string | boolean>; tags: string[] };

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`missing value for ${flag}`);
  return v;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positional: [], flags: {}, tags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") out.flags.force = true;
    else if (a === "--tag") { out.tags.push(requireValue(argv, i, a)); i++; }
    else if (a.startsWith("--")) { out.flags[a.slice(2)] = requireValue(argv, i, a); i++; }
    else out.positional.push(a);
  }
  return out;
}

async function addOne(target: string, note: string | undefined, force: boolean): Promise<void> {
  const slug = isStoreUrl(target)
    ? await ingestAppStore(target, note)
    : await captureWeb(target, { note, force });
  const meta = await analyze(slug);
  console.log(`saved: ${slug} [${meta.status}] tags=${meta.tags.join(",")}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags, tags } = parseArgs(rest);
  const note = typeof flags.note === "string" ? flags.note : undefined;

  switch (cmd) {
    case "add": {
      if (flags.folder) {
        const slug = await ingestFolder({
          folder: String(flags.folder),
          name: String(flags.name ?? "app"),
          platform: (flags.platform as "ios" | "android" | "macos" | "web") ?? "ios",
          note,
        });
        const meta = await analyze(slug);
        console.log(`saved: ${slug} [${meta.status}] tags=${meta.tags.join(",")}`);
        break;
      }
      if (positional.length === 0) throw new Error("usage: add <url...> | add --folder <p> --name <n> --platform <p>");
      let anyFailed = false;
      for (const url of positional) {
        try {
          await addOne(url, note, Boolean(flags.force));
        } catch (err) {
          anyFailed = true;
          console.log(`failed: ${url} — ${err instanceof Error ? err.message : err}`);
        }
      }
      if (anyFailed) process.exitCode = 1;
      break;
    }
    case "capture": {
      if (!positional[0]) throw new Error("usage: capture <url>");
      console.log(await captureWeb(positional[0], { note, force: Boolean(flags.force) }));
      break;
    }
    case "analyze": {
      if (!positional[0]) throw new Error("usage: analyze <slug>");
      const meta = await analyze(positional[0]);
      console.log(`analyzed: ${meta.slug} [${meta.status}]`);
      break;
    }
    case "search": {
      const db = openDb();
      const hits = searchDesigns(db, {
        query: positional.join(" ") || undefined,
        tags: tags.length ? tags : undefined,
        category: typeof flags.category === "string" ? flags.category : undefined,
        limit: flags.limit ? Number(flags.limit) : undefined,
      });
      for (const h of hits) {
        console.log(`${h.slug}  [${h.category}] [${h.source_type}] tags=${h.tags.join(",")}  ${h.snippet}`);
      }
      if (hits.length === 0) console.log("no matches");
      db.close();
      break;
    }
    case "tags": {
      const db = openDb();
      for (const t of listTagCounts(db)) console.log(`${t.tag}\t${t.count}`);
      db.close();
      break;
    }
    case "reindex": {
      const db = openDb();
      console.log(`reindexed ${reindexAll(db)} entries`);
      db.close();
      break;
    }
    default:
      throw new Error(`unknown command "${cmd ?? ""}" — expected add|capture|analyze|search|tags|reindex`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
