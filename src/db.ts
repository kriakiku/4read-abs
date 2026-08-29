import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SCHEMA = /* sql */ `
create table if not exists meta (
  key   text primary key,
  value text not null
);

create table if not exists books (
  source_id     integer primary key,
  url           text    not null,
  slug          text    not null default '',
  title         text    not null default '',
  subtitle      text,
  description   text,
  cover_url     text,
  duration_sec  integer,
  rating        real,
  votes         integer,
  series_key    text,
  series_name   text,
  series_seq    text,
  published_year text,
  lastmod       text,
  first_seen_at text    not null,
  fetched_at    text,
  content_hash  text,
  work_key      text,
  work_label    text,
  isbn          text,
  asin          text,
  hardcover_book_id text,
  hardcover_slug    text,
  hardcover_cover_url text,
  hardcover_series_id text,
  hardcover_match_kind text,
  detail_state  text    not null default 'pending',
  detail_error  text
);
create index if not exists books_work_idx    on books(work_key);
create index if not exists books_series_idx  on books(series_key);
create index if not exists books_state_idx   on books(detail_state);
create index if not exists books_lastmod_idx on books(lastmod);

create table if not exists authors (
  key text primary key,
  name text not null,
  book_count integer,
  hardcover_author_id text,
  hardcover_slug text
);
create table if not exists narrators (
  key text primary key,
  name text not null,
  book_count integer
);
create table if not exists series (
  key text primary key,
  name text not null,
  book_count integer
);
create table if not exists genres (
  key text primary key,
  name text not null
);

create table if not exists book_authors (
  source_id integer not null,
  author_key text not null,
  primary key (source_id, author_key)
);
create table if not exists book_narrators (
  source_id integer not null,
  narrator_key text not null,
  primary key (source_id, narrator_key)
);
create table if not exists book_genres (
  source_id integer not null,
  genre_key text not null,
  primary key (source_id, genre_key)
);
create table if not exists book_tags (
  source_id integer not null,
  tag text not null,
  primary key (source_id, tag)
);
create index if not exists book_authors_key_idx   on book_authors(author_key);
create index if not exists book_narrators_key_idx on book_narrators(narrator_key);
create index if not exists book_genres_key_idx    on book_genres(genre_key);
create index if not exists book_tags_tag_idx      on book_tags(tag);

create table if not exists queue (
  id integer primary key autoincrement,
  source_id integer not null unique,
  reason text not null,
  state text not null default 'new',
  note text,
  created_at text not null,
  updated_at text not null
);
create index if not exists queue_state_idx on queue(state);

create table if not exists abs_links (
  source_id       integer not null,
  abs_item_id     text    not null,
  abs_library_id  text,
  abs_path        text,
  written_hash    text,
  -- Last payload we wrote, so 'overwrite-ours' can tell our values from manual edits.
  written_payload text,
  written_at      text,
  pinned          integer not null default 0,
  confidence      real,
  primary key (source_id, abs_item_id)
);
create unique index if not exists abs_links_item_idx on abs_links(abs_item_id);

create table if not exists hardcover_cache (
  query_key  text primary key,
  response   text not null,
  fetched_at text not null
);

create table if not exists ai_cache (
  query_key  text primary key,
  response   text not null,
  fetched_at text not null
);

create table if not exists fetch_log (
  id integer primary key autoincrement,
  at        text not null,
  url       text not null,
  strategy  text,
  status    integer,
  ok        integer not null default 0,
  challenge integer not null default 0,
  ms        integer,
  error     text
);
create index if not exists fetch_log_at_idx on fetch_log(at);
`;

export type Db = Database;

function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const rows = db.query<{ name: string }, []>(`pragma table_info(${table})`).all();
  if (rows.some((row) => row.name === column)) return;
  db.run(`alter table ${table} add column ${ddl}`);
}

export function openDb(dataDir: string): Db {
  const dir = resolve(dataDir);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "4read-abs.db"), { create: true });
  db.run("pragma journal_mode = WAL");
  db.run("pragma foreign_keys = ON");
  db.run("pragma busy_timeout = 5000");
  db.run(SCHEMA);
  // Existing installs created books before these enrichment columns existed.
  ensureColumn(db, "books", "hardcover_cover_url", "hardcover_cover_url text");
  ensureColumn(db, "books", "hardcover_series_id", "hardcover_series_id text");
  ensureColumn(db, "books", "hardcover_match_kind", "hardcover_match_kind text");
  return db;
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.query<{ value: string }, [string]>("select value from meta where key = ?").get(key);
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.query("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(
    key,
    value,
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Trim the fetch log so a long-running instance does not grow without bound. */
export function pruneFetchLog(db: Db, keep = 5000): void {
  db.run(
    "delete from fetch_log where id not in (select id from fetch_log order by id desc limit ?)",
    [keep],
  );
}
