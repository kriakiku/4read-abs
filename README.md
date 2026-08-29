# 4read-abs

Reads audiobook metadata from [4read.org](https://4read.org) and keeps
[Audiobookshelf](https://www.audiobookshelf.org) in step with it: genres, author, narrator,
series and position, cover, description and duration. You can subscribe to a series, an author
or a narrator, and new releases land in a queue in a small web interface.

Metadata reaches Audiobookshelf as a `metadata.json` sidecar plus a cover file, written next to
the book. That is the highest-priority local metadata source in Audiobookshelf, so it wins over
folder names and embedded tags without any plugin or API push.

## What it extracts

The site runs DataLife Engine with schema.org microdata, so the interesting fields are
structured rather than guessed at, and the site's own facet URLs double as stable identifiers:

| Field | Source | Identifier |
| --- | --- | --- |
| Genres | category links | `/fentezi/` → `fentezi` |
| Author | `itemprop="author"` | `/xfsearch/avtor/<name>/` |
| Narrator | `itemprop="readBy"` | `/xfsearch/chitaet/<name>/` |
| Series and position | `schema.org/PublicationVolume` | `/xfsearch/cikl/<name>/` + `volumeNumber` |
| Cover | `og:image` | — |
| Duration, rating, votes | `meta[itemprop="duration"]`, rating block | — |
| Book | canonical URL | numeric post id, e.g. `6840` |

Standalone books simply have no series block, which is handled as a normal case.

Discovery is driven by `sitemap.xml` → `news_pages.xml`, where every entry carries a `lastmod`,
so routine syncs only refetch pages that actually changed. `avtors.html` and `readers.html`
enumerate every author and narrator with a book count, which means the whole entity space is
known after two requests and subscriptions can be set up before the detail crawl finishes.

## Cloudflare, and why FlareSolverr matters

The entire site sits behind a Cloudflare managed challenge. A plain HTTP client gets `403` on
every path, including `robots.txt`. Without help, this tool can do nothing.

Point `FLARESOLVERR_URL` at a [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)
instance and it works: FlareSolverr drives a real browser to pass the challenge, and the
resulting `cf_clearance` cookie is harvested and reused for ordinary requests. Covers always go
over a direct request, because FlareSolverr only returns HTML; when a cover is blocked, the
clearance is refreshed through FlareSolverr and the download is retried.

Three modes via `FLARESOLVERR_MODE`:

- `auto` (default) — try a plain request first, escalate only when challenged
- `always` — send every page through FlareSolverr
- `never` — never use it

The site also reacts to burst volume rather than to a steady rate, so requests are paced by an
adaptive limiter: the interval doubles on each challenge, decays back down while things are
healthy, and repeated challenges trigger a long cooldown. Expect a full first-time crawl of
roughly 5,000 pages to take hours; it is resumable and checkpointed, and day-to-day syncs are
cheap because of `lastmod`.

## Install

### Binary

Each release publishes a single self-contained `linux-amd64` executable with the Bun runtime
baked in — no runtime dependencies.

```bash
curl -fsSLO https://github.com/kriakiku/4read-abs/releases/latest/download/4read-abs-linux-amd64
chmod +x 4read-abs-linux-amd64
cp config.example.yaml config.yaml
./4read-abs-linux-amd64 serve
```

### Docker Compose

Brings up FlareSolverr alongside the service:

```bash
cp config.example.yaml config/config.yaml
ABS_URL=http://audiobookshelf:13378 ABS_API_KEY=... docker compose up -d
```

Adjust the `/library` volume to point at the same audiobook library Audiobookshelf uses. It has
to be writable, since metadata is delivered as files.

## Configuration

Secrets come from the environment and override the file, so the YAML the web editor round-trips
never holds credentials:

| Variable | Purpose |
| --- | --- |
| `ABS_URL`, `ABS_API_KEY` | Audiobookshelf server and API key |
| `ABS_LIBRARY_DIR` | The Audiobookshelf library as this process sees it |
| `FLARESOLVERR_URL`, `FLARESOLVERR_MODE` | Cloudflare bypass |
| `HARDCOVER_API_KEY` | Enables Hardcover enrichment |
| `STAGING_DIR`, `DATA_DIR`, `CONFIG_FILE` | Paths |
| `HOST`, `PORT`, `LOG_LEVEL` | Web interface and logging |

Everything else lives in `config.yaml` (see `config.example.yaml`) and is editable from the web
interface, which validates before saving and reloads on success. There is no authentication, so
bind it to loopback — the default is `127.0.0.1:8480`.

## Audiobookshelf setup

1. **Leave the metadata precedence alone.** The default order is
   `folderStructure, audioMetatags, nfoFile, txtFiles, opfFile, absMetadata`, applied lowest to
   highest, so `absMetadata` (`metadata.json`) wins. If you have reordered it, move the
   Audiobookshelf metadata file back to the top.
2. **Mount the library.** The service writes into each book's folder, so it needs the library on
   a writable path.
3. **Map the paths if they differ.** Audiobookshelf reports paths from inside its own container.
   If yours differ, translate them the way Sonarr and Radarr do:

   ```yaml
   audiobookshelf:
     pathMappings:
       - from: /audiobooks
         to: /library
   ```

4. **Create an API key** in Audiobookshelf and pass it as `ABS_API_KEY`. The API is used to list
   items, find their folders and rescan a single item after its sidecar changes.

### How writes are decided

`sync.writePolicy` controls how much the service is allowed to touch:

- `fill-empty` — only populate fields Audiobookshelf left empty
- `overwrite-ours` (default) — replace values we wrote last time, but leave anything edited by
  hand in the Audiobookshelf UI alone
- `overwrite-all` — always write our values

Each item gets a `4read:<id>` tag, which is how it is re-identified on later runs without fuzzy
matching. Items without that tag are matched on normalised title and author, tolerating both
Cyrillic and transliterated spellings; anything below `sync.matchThreshold` is left for you to
confirm in the web interface rather than guessed at.

## Staging and hardlinks

Every book is assembled in its own folder under `STAGING_DIR` first and only published to the
library once it is complete, so Audiobookshelf never sees a half-written book.

Publishing treats the two kinds of file differently, and the distinction matters:

- **Media files are hardlinked**, so nothing is stored twice. If the target is on another
  filesystem the link falls back to a copy (`sync.onCrossDevice`), so keep staging and the
  library on the same filesystem to get the benefit. Set `sync.linkMode: copy` to always copy.
- **`metadata.json` and the cover are copied.** Audiobookshelf rewrites `metadata.json` in place
  when you edit an item, and a hardlink would silently rewrite the staging copy too.

If you drop your own audio files into a staged folder, they are hardlinked along with the rest
the next time the book is published.

With `sync.createFolders` enabled, books you accept from the queue that are not in the library
yet get a folder prepared from `sync.folderTemplate` with metadata and cover already in place,
ready for audio to be added.

## Subscriptions

```yaml
narrators:
  prefer:
    - Характерник
    - Ада Роговцева
  block: []

subscriptions:
  - type: series
    value: "all the young dudes"
  - type: author
    value: "Агата Крісті"
  - type: narrator
    value: "Характерник"
```

Subscriptions match on `author`, `narrator`, `series`, `genre` or `tag`, by identifier or by
display name.

The same book often exists in several readings. Those are grouped into one work — the grouping
folds the different ways a volume is written (`Книга 2`, `(Т. 2)`, `Частина II`) onto one token,
so different volumes stay separate while different spellings converge — and one reading is
chosen. Narrator preference dominates deliberately: a favourite narrator wins even over a better
rated alternative, blocked narrators are dropped unless nothing else exists, and rating only
breaks ties, damped by the vote count so a single enthusiastic vote cannot win.

Books already in your library are not surfaced as news; their metadata is refreshed instead.

## Hardcover enrichment

Optional. Set `HARDCOVER_API_KEY` and the service looks up canonical Hardcover ids and fills in
ISBN and ASIN when it is confident, which lets Audiobookshelf match against other providers
afterwards. Results are cached permanently and requests are paced well inside the free tier.
Coverage of Ukrainian editions is patchy, so this only ever adds information: the site's own
identifiers remain the source of truth and every failure is silent.

## CLI

Useful for cron instead of the built-in scheduler:

```
4read-abs serve           Web interface and scheduler (default)
4read-abs seed            Fetch the author and narrator indexes
4read-abs sitemap         Reconcile the catalogue with the sitemap
4read-abs backfill [n]    Fetch up to n pending detail pages
4read-abs subscriptions   Re-evaluate subscriptions and refill the queue
4read-abs sync            Write sidecars into the library
4read-abs once            sitemap, then subscriptions, then sync
```

## Scope

This tool handles metadata only and does not download audio. The site's `robots.txt` disallows
`/m3u/`, `/bed/` and `do=download` — the audio endpoints — while permitting the article and
listing pages it reads. Subscriptions produce metadata and notifications; you supply the media.

## Development

```bash
bun install
bun test          # 110 tests, no network access required
bun run typecheck
bun run dev
bun run build     # dist/4read-abs, a single linux-amd64 executable
```

Parsers are tested against real pages captured from the site under `test/fixtures/`, and the
end-to-end tests run the whole pipeline against a mock 4read.org and a mock Audiobookshelf, so
the suite is fully offline.
