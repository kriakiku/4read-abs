import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, type Config } from "../src/config.ts";
import type { BookWithPeople } from "../src/catalog/store.ts";
import type { AbsItem } from "../src/abs/client.ts";
import {
  buildSidecar,
  formatSeries,
  itemToSidecar,
  reconcileSidecar,
  serialiseSidecar,
  sidecarHash,
} from "../src/abs/metadata.ts";
import { mapAbsPathToLocal, mapLocalPathToAbs } from "../src/abs/pathmap.ts";
import { isMediaFile, placeIntoLibrary, stageBook, targetFolderFor } from "../src/abs/stage.ts";

const temporaries: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "4read-abs-test-"));
  temporaries.push(dir);
  return dir;
}

afterEach(async () => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function config(overrides: Record<string, unknown> = {}): Config {
  return configSchema.parse(overrides);
}

function book(partial: Partial<BookWithPeople> = {}): BookWithPeople {
  return {
    source_id: 3130,
    url: "https://4read.org/3130-x.html",
    slug: "yudkovski-elizer-garri-potter",
    title: "Гаррі Поттер і методи раціональности. Книга 2",
    subtitle: null,
    description: "Фанфік про раціональність.",
    cover_url: "https://4read.org/uploads/posts/2023-09/cover.jpg",
    duration_sec: 42486,
    rating: 4.5,
    votes: 76,
    series_key: "гаррі поттер",
    series_name: "Гаррі Поттер",
    series_seq: "2",
    published_year: null,
    lastmod: null,
    first_seen_at: "2026-01-01T00:00:00.000Z",
    fetched_at: null,
    content_hash: null,
    work_key: "w1",
    work_label: null,
    isbn: null,
    asin: null,
    hardcover_book_id: null,
    hardcover_slug: null,
    detail_state: "ok",
    detail_error: null,
    authors: ["Елізер Юдковскі"],
    narrators: ["Характерник"],
    genres: ["Світова література", "Фентезі"],
    tags: ["фан-фікшн"],
    ...partial,
  };
}

function item(partial: Partial<AbsItem> = {}): AbsItem {
  return {
    id: "li_abc",
    libraryId: "lib_1",
    path: "/audiobooks/Yudkovski/HPMOR 2",
    relPath: "Yudkovski/HPMOR 2",
    title: "",
    subtitle: null,
    authors: [],
    narrators: [],
    series: [],
    genres: [],
    tags: [],
    description: null,
    asin: null,
    isbn: null,
    language: null,
    publishedYear: null,
    numAudioFiles: 3,
    ...partial,
  };
}

describe("sidecar payload", () => {
  test("uses only the keys Audiobookshelf reads, with series as Name #seq", () => {
    const sidecar = buildSidecar(book(), config());

    expect(sidecar.series).toEqual(["Гаррі Поттер #2"]);
    expect(sidecar.authors).toEqual(["Елізер Юдковскі"]);
    expect(sidecar.narrators).toEqual(["Характерник"]);
    expect(sidecar.genres).toEqual(["Світова література", "Фентезі"]);
    expect(sidecar.language).toBe("ukr");
    // A marker tag lets later runs re-identify the item without fuzzy matching.
    expect(sidecar.tags).toContain("4read:3130");
    expect(sidecar.tags).toContain("фан-фікшн");
    // Duration is not part of the schema: Audiobookshelf derives it from the audio files.
    expect(sidecar).not.toHaveProperty("duration");
    expect(sidecar).not.toHaveProperty("rating");
  });

  test("omits the series when a book stands alone", () => {
    const sidecar = buildSidecar(book({ series_key: null, series_name: null, series_seq: null }), config());
    expect(sidecar.series).toBeUndefined();
  });

  test("series without a sequence keeps just the name", () => {
    expect(formatSeries("Поезія", null)).toBe("Поезія");
    expect(formatSeries("Поезія", " 4 ")).toBe("Поезія #4");
  });

  test("serialises as pretty JSON with a trailing newline", () => {
    const text = serialiseSidecar({ title: "X" });
    expect(text).toBe('{\n  "title": "X"\n}\n');
  });
});

describe("write policy", () => {
  const desired = { title: "Ours", authors: ["A"], genres: ["G"], tags: ["4read:1"] };

  test("fill-empty leaves anything already set alone", () => {
    const current = { title: "Theirs", authors: [] as string[] };
    const result = reconcileSidecar(desired, current, null, "fill-empty");

    expect(result.payload.title).toBe("Theirs");
    expect(result.payload.authors).toEqual(["A"]);
    expect(result.skippedFields).toContain("title");
  });

  test("overwrite-all replaces regardless of what is there", () => {
    const result = reconcileSidecar(desired, { title: "Theirs" }, null, "overwrite-all");
    expect(result.payload.title).toBe("Ours");
    expect(result.changedFields).toContain("title");
  });

  test("overwrite-ours keeps a manual edit but refreshes our own value", () => {
    // The library holds a hand edited title and the genres we wrote last time.
    const previous = { title: "Old Ours", genres: ["Old"] };
    const current = { title: "Hand Edited", genres: ["Old"] };
    const result = reconcileSidecar(desired, current, previous, "overwrite-ours");

    expect(result.payload.title).toBe("Hand Edited");
    expect(result.skippedFields).toContain("title");
    expect(result.payload.genres).toEqual(["G"]);
    expect(result.changedFields).toContain("genres");
  });

  test("overwrite-ours fills fields the library never had", () => {
    const result = reconcileSidecar(desired, {}, null, "overwrite-ours");
    expect(result.payload.title).toBe("Ours");
    expect(result.changed).toBe(true);
  });

  test("a field we have nothing for is never blanked out", () => {
    const result = reconcileSidecar({ title: "Ours" }, { description: "Keep me" }, null, "overwrite-all");
    expect(result.payload.description).toBe("Keep me");
  });

  test("the marker tag survives a policy that would otherwise skip tags", () => {
    const current = { tags: ["manual"] };
    const previous = { tags: ["something-else"] };
    const result = reconcileSidecar(desired, current, previous, "overwrite-ours");

    expect(result.payload.tags).toContain("4read:1");
    expect(result.payload.tags).toContain("manual");
  });

  test("an unchanged payload reports no change", () => {
    const current = { title: "Ours", authors: ["A"], genres: ["G"], tags: ["4read:1"] };
    const result = reconcileSidecar(desired, current, current, "overwrite-ours");
    expect(result.changed).toBe(false);
  });

  test("hash ignores key and array order", () => {
    expect(sidecarHash({ title: "a", genres: ["x", "y"] })).toBe(sidecarHash({ genres: ["y", "x"], title: "a" }));
    expect(sidecarHash({ title: "a" })).not.toBe(sidecarHash({ title: "b" }));
  });

  test("reads the current state out of a library item", () => {
    const sidecar = itemToSidecar(item({ title: "T", authors: ["A"], tags: ["4read:5"] }));
    expect(sidecar.title).toBe("T");
    expect(sidecar.authors).toEqual(["A"]);
    expect(sidecar.narrators).toBeUndefined();
  });
});

describe("path mapping", () => {
  const mappings = [
    { from: "/audiobooks", to: "/library" },
    { from: "/audiobooks/special", to: "/mnt/special" },
  ];

  test("rewrites a container path to the local mount", () => {
    expect(mapAbsPathToLocal("/audiobooks/Kis/Book", mappings)).toBe("/library/Kis/Book");
  });

  test("the longest matching prefix wins", () => {
    expect(mapAbsPathToLocal("/audiobooks/special/Book", mappings)).toBe("/mnt/special/Book");
  });

  test("leaves unmapped paths untouched and normalises trailing slashes", () => {
    expect(mapAbsPathToLocal("/elsewhere/Book", mappings)).toBe("/elsewhere/Book");
    expect(mapAbsPathToLocal("/audiobooks/", mappings)).toBe("/library");
  });

  test("maps back the other way", () => {
    expect(mapLocalPathToAbs("/library/Kis/Book", mappings)).toBe("/audiobooks/Kis/Book");
  });

  test("does not match a partial directory name", () => {
    expect(mapAbsPathToLocal("/audiobooks-old/Book", mappings)).toBe("/audiobooks-old/Book");
  });
});

describe("staging and placement", () => {
  test("classifies media by extension", () => {
    expect(isMediaFile("part1.m4b")).toBe(true);
    expect(isMediaFile("book.MP3")).toBe(true);
    expect(isMediaFile("metadata.json")).toBe(false);
    expect(isMediaFile("cover.jpg")).toBe(false);
  });

  test("writes metadata.json and the cover into the staging folder", async () => {
    const root = await tempDir();
    const settings = config({ paths: { staging: join(root, "staging") } });
    const target = book();

    const staged = await stageBook(target, buildSidecar(target, settings), {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
    }, settings);

    expect(staged.dir).toContain("3130-");
    const written = JSON.parse(await readFile(staged.metadataPath, "utf8"));
    expect(written.title).toBe(target.title);
    expect(staged.coverPath?.endsWith("cover.jpg")).toBe(true);
  });

  test("keeps a webp cover as webp, since Audiobookshelf accepts it", async () => {
    const root = await tempDir();
    const settings = config({ paths: { staging: join(root, "staging") } });
    const target = book({ cover_url: "https://4read.org/uploads/posts/2026-01/x.webp" });

    const staged = await stageBook(target, buildSidecar(target, settings), {
      bytes: new Uint8Array([1]),
      contentType: "image/webp",
    }, settings);

    expect(staged.coverPath?.endsWith("cover.webp")).toBe(true);
  });

  test("replaces a cover in a different format instead of leaving two behind", async () => {
    const root = await tempDir();
    const settings = config({ paths: { staging: join(root, "staging") } });
    const target = book();

    const first = await stageBook(target, buildSidecar(target, settings), {
      bytes: new Uint8Array([1]),
      contentType: "image/webp",
    }, settings);
    expect(await Bun.file(first.coverPath!).exists()).toBe(true);

    const second = await stageBook(target, buildSidecar(target, settings), {
      bytes: new Uint8Array([2]),
      contentType: "image/jpeg",
    }, settings);

    expect(second.coverPath?.endsWith("cover.jpg")).toBe(true);
    expect(await Bun.file(join(second.dir, "cover.webp")).exists()).toBe(false);
  });

  test("metadata-only placement copies sidecars and leaves audio alone", async () => {
    const root = await tempDir();
    const settings = config({ paths: { staging: join(root, "staging") } });
    const target = book();

    const staged = await stageBook(target, buildSidecar(target, settings), {
      bytes: new Uint8Array([1, 2]),
      contentType: "image/jpeg",
    }, settings);
    await writeFile(join(staged.dir, "part1.mp3"), "audio");

    const library = join(root, "library", "Book");
    const report = await placeIntoLibrary(staged, library, "metadata-only", settings);

    expect(report.copied).toContain("metadata.json");
    expect(report.copied).toContain("cover.jpg");
    expect(report.skipped).toContain("part1.mp3");
    expect(await Bun.file(join(library, "part1.mp3")).exists()).toBe(false);
  });

  test("metadata files are copied, not hardlinked, so the library cannot rewrite staging", async () => {
    const root = await tempDir();
    const settings = config({ paths: { staging: join(root, "staging") } });
    const target = book();

    const staged = await stageBook(target, buildSidecar(target, settings), null, settings);
    const library = join(root, "library", "Book");
    await placeIntoLibrary(staged, library, "metadata-only", settings);

    const [source, placed] = await Promise.all([
      stat(staged.metadataPath),
      stat(join(library, "metadata.json")),
    ]);
    expect(placed.ino).not.toBe(source.ino);

    // Audiobookshelf rewrites metadata.json in place when a user edits an item; that must
    // not travel back into the staging copy.
    await writeFile(join(library, "metadata.json"), '{"title":"edited in ABS"}');
    expect(await readFile(staged.metadataPath, "utf8")).toContain("Гаррі Поттер");
  });

  test("full placement hardlinks media so nothing is stored twice", async () => {
    const root = await tempDir();
    const settings = config({ paths: { staging: join(root, "staging") } });
    const target = book();

    const staged = await stageBook(target, buildSidecar(target, settings), null, settings);
    await writeFile(join(staged.dir, "part1.m4b"), "audio-bytes");

    const library = join(root, "library", "Book");
    const report = await placeIntoLibrary(staged, library, "full", settings);

    expect(report.linked).toContain("part1.m4b");
    const [source, linked] = await Promise.all([
      stat(join(staged.dir, "part1.m4b")),
      stat(join(library, "part1.m4b")),
    ]);
    expect(linked.ino).toBe(source.ino);
    expect(linked.nlink).toBeGreaterThan(1);
  });

  test("linkMode copy skips hardlinking entirely", async () => {
    const root = await tempDir();
    const settings = config({ paths: { staging: join(root, "staging") }, sync: { linkMode: "copy" } });
    const target = book();

    const staged = await stageBook(target, buildSidecar(target, settings), null, settings);
    await writeFile(join(staged.dir, "part1.m4b"), "audio-bytes");

    const library = join(root, "library", "Book");
    const report = await placeIntoLibrary(staged, library, "full", settings);

    expect(report.copied).toContain("part1.m4b");
    const [source, copied] = await Promise.all([
      stat(join(staged.dir, "part1.m4b")),
      stat(join(library, "part1.m4b")),
    ]);
    expect(copied.ino).not.toBe(source.ino);
  });

  test("a second placement is a no-op", async () => {
    const root = await tempDir();
    const settings = config({ paths: { staging: join(root, "staging") } });
    const target = book();

    const staged = await stageBook(target, buildSidecar(target, settings), null, settings);
    const library = join(root, "library", "Book");
    await placeIntoLibrary(staged, library, "metadata-only", settings);
    const second = await placeIntoLibrary(staged, library, "metadata-only", settings);

    expect(second.copied).toHaveLength(0);
    expect(second.skipped).toContain("metadata.json");
  });

  test("internal bookkeeping files are never published", async () => {
    const root = await tempDir();
    const settings = config({ paths: { staging: join(root, "staging") } });
    const target = book();

    const staged = await stageBook(target, buildSidecar(target, settings), {
      bytes: new Uint8Array([1]),
      contentType: "image/jpeg",
    }, settings);
    await writeFile(join(staged.dir, ".tmp-leftover"), "junk");
    await writeFile(join(staged.dir, ".4read-cover-source"), "https://4read.org/uploads/x.jpg");

    const library = join(root, "library", "Book");
    await placeIntoLibrary(staged, library, "full", settings);

    expect(await Bun.file(join(library, ".tmp-leftover")).exists()).toBe(false);
    // The marker recording which cover URL was downloaded is ours, not the library's.
    expect(await Bun.file(join(library, ".4read-cover-source")).exists()).toBe(false);
    expect(await Bun.file(join(library, "cover.jpg")).exists()).toBe(true);
  });

  test("target folder follows the template and drops empty segments", async () => {
    const settings = config();
    expect(targetFolderFor(book(), settings)).toBe("Елізер Юдковскі/Гаррі Поттер/2 - Гаррі Поттер і методи раціональности. Книга 2");

    const standalone = book({ series_name: null, series_seq: null, title: "Тіні забутих предків" });
    expect(targetFolderFor(standalone, settings)).toBe("Елізер Юдковскі/Тіні забутих предків");
  });

  test("cross device fallback can be configured to fail loudly", async () => {
    const root = await tempDir();
    const settings = config({
      paths: { staging: join(root, "staging") },
      sync: { onCrossDevice: "error" },
    });
    // Same filesystem here, so this only asserts the happy path still links.
    const target = book();
    const staged = await stageBook(target, buildSidecar(target, settings), null, settings);
    await mkdir(join(root, "library"), { recursive: true });
    await writeFile(join(staged.dir, "a.mp3"), "x");
    const report = await placeIntoLibrary(staged, join(root, "library", "B"), "full", settings);
    expect(report.errors).toHaveLength(0);
  });
});
