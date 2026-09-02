import Database from 'better-sqlite3';
import { CID } from 'multiformats/cid';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface Community {
  address: string;
  title: string | null;
  description: string | null;
  added_at: number;
  last_indexed_at: number | null;
  /**
   * The community's own `features.safeForWork`, as the last crawl saw it.
   * Three-state, like the protocol field: 1 = declared safe for work,
   * 0 = declared NSFW, NULL = the owner never declared either way.
   */
  safe_for_work: number | null;
  /** Resolved NSFW flag — see resolveNsfw / applyNsfwSignals below. */
  nsfw: number;
}

export interface Comment {
  cid: string;
  community_address: string;
  post_cid: string;
  parent_cid: string | null;
  depth: number;
  timestamp: number;
  author_address: string | null;
  author_name: string | null;
  title: string | null;
  content: string | null;
  link: string | null;
  thumbnail_url: string | null;
  upvote_count: number;
  downvote_count: number;
  reply_count: number;
  raw: string | null;
  indexed_at: number;
  removed_at: number | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
  pending_approval: number;
  removed: number;
  deleted: number;
  mod_reason: string | null;
  upstream_archived: number;
  nsfw: number;
  takedown: number;
  takedown_reason: string | null;
}

/** A comment as served by the API: archive/tombstone state made explicit. */
export interface ServedComment extends Comment {
  /** 1 when the thread is no longer live upstream (explicit flag or fell out of the crawl). */
  archived: number;
}

export type Sort = 'new' | 'old' | 'top' | 'replies';
export type TimeRange = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export interface ListOpts {
  community?: string;
  sort?: Sort;
  time?: TimeRange;
  page?: number;
  limit?: number;
  includeReplies?: boolean;
  /**
   * NSFW filter. `false` drops results that are NSFW — the comment carries the
   * protocol flag, or its community does. `true`/undefined filters nothing, so
   * listings and the sitemap keep their existing behaviour; only /api/search
   * opts in, and it defaults to excluding.
   */
  nsfw?: boolean;
}

/** `self:yes` (text posts only) / `self:no` (link posts only). */
export type SelfFilter = 'yes' | 'no';

/**
 * The old.reddit-style advanced filters `/api/search` accepts alongside `q`.
 * Every one is optional and they AND together — with each other and with
 * `q`/`community`/`time`/`nsfw` — so a query only ever narrows as filters are
 * added. They are search-only: `/api/posts` and the sitemap never pass them.
 */
export interface SearchFilters {
  /**
   * `author:lena.bso` — an exact, case-insensitive match against EITHER the
   * author's address or their display name, because a user may type either and
   * neither can be derived from the other. Exact rather than prefix/substring
   * on purpose: an author is an identity, so `author:lena` must not quietly
   * widen to `lena-imposter.bso`. (old.reddit's `author:` is exact too.)
   */
  author?: string;
  /**
   * `site:example.com` — the link's *host*, parsed, never a substring of the
   * whole URL, or `site:example.com` would also match
   * `https://evil.com/?r=example.com`. Subdomains count: it matches
   * `www.example.com` and `sub.example.com` as well, since `www.` is the most
   * common stored form and people mean "posts linking to that site", not "to
   * that exact hostname". Use `url` when you want the narrower thing.
   */
  site?: string;
  /**
   * `url:ink-study` — a case-insensitive substring of the whole link. Kept
   * distinct from `site`: this is how a path, slug or query fragment is found.
   */
  url?: string;
  /**
   * `selftext:tokenizer` — words in the post body. Routed through the FTS index
   * (its `content` column) rather than a LIKE over `comments.content`: same
   * word-prefix semantics as `q`, and it keeps a body-only search an index seek
   * instead of a scan of the whole archive.
   */
  selftext?: string;
  /**
   * `self:yes` / `self:no`. Three-state: absent means "no opinion" and filters
   * nothing. A boolean with a default would make an absent parameter silently
   * drop every link post.
   */
  self?: SelfFilter;
}

const TIME_WINDOW: Record<Exclude<TimeRange, 'all'>, number> = {
  hour: 3_600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  year: 31_536_000,
};

const ORDER_BY: Record<Sort, string> = {
  new: 'c.timestamp DESC',
  old: 'c.timestamp ASC',
  top: '(c.upvote_count - c.downvote_count) DESC, c.timestamp DESC',
  replies: 'c.reply_count DESC, c.timestamp DESC',
};

/**
 * A comment is "archived" (no longer live upstream) when its CommentUpdate said
 * so explicitly, or when the community has been crawled successfully after the
 * last time this comment appeared in its pages.
 */
const ARCHIVED_SQL = `CASE WHEN c.upstream_archived = 1
    OR (c.last_seen_at IS NOT NULL AND m.last_indexed_at IS NOT NULL AND c.last_seen_at < m.last_indexed_at)
  THEN 1 ELSE 0 END`;

/** `m` is the comment's community row; every query below reads flags off it. */
const JOIN_COMMUNITY = 'LEFT JOIN communities m ON m.address = c.community_address';

const SERVED_SELECT = `SELECT c.*, ${ARCHIVED_SQL} AS archived
   FROM comments c ${JOIN_COMMUNITY}`;

/** Filter applied to every listing/search: mod-queue content is never served. */
const NOT_PENDING = 'c.pending_approval = 0';
/** Listings and search additionally hide tombstones (they have no content). */
const VISIBLE = `${NOT_PENDING} AND c.removed = 0 AND c.deleted = 0 AND c.takedown = 0`;

/**
 * Opt-in NSFW exclusion. A result is NSFW when the comment itself carries the
 * protocol flag or its community is resolved NSFW. `m` can be absent (a comment
 * whose community row was never created), which counts as not-NSFW.
 */
const NOT_NSFW = 'c.nsfw = 0 AND COALESCE(m.nsfw, 0) = 0';

const nowSec = () => Math.floor(Date.now() / 1000);

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (db) return db;
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  // `site:` searches match a link's parsed host, which SQL cannot work out on
  // its own. Deterministic so SQLite may reuse the value within a statement;
  // deliberately never used in an index, because an index over an app-defined
  // function makes the file unreadable to a connection that never registered it.
  db.function('link_host', { deterministic: true }, (link) => linkHost(link as string | null));
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/** Additive migrations for databases created before a column existed in schema.sql. */
function migrate(database: Database.Database): void {
  const added = addColumns(database, 'comments', {
    first_seen_at: 'INTEGER',
    last_seen_at: 'INTEGER',
    pending_approval: 'INTEGER NOT NULL DEFAULT 0',
    removed: 'INTEGER NOT NULL DEFAULT 0',
    deleted: 'INTEGER NOT NULL DEFAULT 0',
    mod_reason: 'TEXT',
    upstream_archived: 'INTEGER NOT NULL DEFAULT 0',
    takedown: 'INTEGER NOT NULL DEFAULT 0',
    takedown_reason: 'TEXT',
  });
  if (added) {
    // Backfill seen-times for rows indexed before the columns existed.
    database.exec('UPDATE comments SET first_seen_at = indexed_at WHERE first_seen_at IS NULL');
    database.exec('UPDATE comments SET last_seen_at = indexed_at WHERE last_seen_at IS NULL');
  }
  // Crawl leases (see crawler/queue.ts). A pre-existing 'running' row has no
  // start time, so it reads as abandoned — which is exactly right: it was
  // claimed by a process that is long gone.
  addColumns(database, 'crawl_queue', { started_at: 'INTEGER' });

  // NSFW tracking. Deliberately its own call: an existing archive gaining only
  // these columns must not re-run the seen-time backfill above. The resolved
  // flags default to 0 (= not NSFW), so every already-indexed row keeps serving
  // exactly as before until a signal says otherwise, while safe_for_work is
  // deliberately nullable-with-no-default: on an archive predating it, every
  // community reads back as "the owner never declared", which is the truth
  // until a crawl observes the feature.
  addColumns(database, 'comments', { nsfw: 'INTEGER NOT NULL DEFAULT 0' });
  addColumns(database, 'communities', {
    nsfw: 'INTEGER NOT NULL DEFAULT 0',
    safe_for_work: 'INTEGER',
  });
  // Partial index: inference only ever asks which communities have a flagged
  // comment, so indexing the flagged rows alone keeps that a seek instead of a
  // scan of the whole archive. Lives here, not in schema.sql, because that file
  // runs before the ALTER above on a pre-existing database.
  database.exec('CREATE INDEX IF NOT EXISTS idx_comments_nsfw ON comments(community_address) WHERE nsfw = 1');
}

/** Add every missing column to `table`. Returns true when it changed anything. */
function addColumns(database: Database.Database, table: string, columns: Record<string, string>): boolean {
  const existing = new Set((database.pragma(`table_info('${table}')`) as { name: string }[]).map((c) => c.name));
  let added = false;
  for (const [name, type] of Object.entries(columns)) {
    if (existing.has(name)) continue;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    added = true;
  }
  return added;
}

function all<T>(sql: string, params: Record<string, unknown> = {}): T[] {
  const stmt = getDb().prepare(sql);
  return (Object.keys(params).length ? stmt.all(params) : stmt.all()) as T[];
}

function one<T>(sql: string, params: Record<string, unknown> = {}): T | undefined {
  const stmt = getDb().prepare(sql);
  return (Object.keys(params).length ? stmt.get(params) : stmt.get()) as T | undefined;
}

/**
 * Tombstone redaction: removed (mod) / deleted (author) / takedown (operator
 * blocklist) comments keep their row so thread structure survives, but their
 * content is never served.
 */
function serve(row: ServedComment): ServedComment {
  if (!row.removed && !row.deleted && !row.takedown) return row;
  return {
    ...row,
    title: null,
    content: null,
    link: null,
    thumbnail_url: null,
    author_address: null,
    author_name: null,
    raw: null,
  };
}

// ── communities ────────────────────────────────────────────────────────────

/**
 * Insert or refresh a community row.
 *
 * `safe_for_work` cannot use the COALESCE-keeps-the-old-value rule the other
 * columns use: NULL is a real value there (the owner declared nothing), not a
 * missing one. So it is written only when the caller passes the key at all —
 * a crawl that resolved the community states all three outcomes, and merely
 * scheduling an address leaves the last declaration alone.
 */
export function upsertCommunity(c: Pick<Community, 'address'> & Partial<Community>): void {
  getDb()
    .prepare(
      `INSERT INTO communities (address, title, description, added_at, last_indexed_at, safe_for_work)
       VALUES (@address, @title, @description, @added_at, @last_indexed_at, @safe_for_work)
       ON CONFLICT(address) DO UPDATE SET
         title = COALESCE(excluded.title, communities.title),
         description = COALESCE(excluded.description, communities.description),
         last_indexed_at = COALESCE(excluded.last_indexed_at, communities.last_indexed_at),
         safe_for_work = CASE WHEN @observed_safe_for_work = 1
           THEN excluded.safe_for_work ELSE communities.safe_for_work END`,
    )
    .run({
      address: c.address,
      title: c.title ?? null,
      description: c.description ?? null,
      added_at: c.added_at ?? nowSec(),
      last_indexed_at: c.last_indexed_at ?? null,
      safe_for_work: c.safe_for_work ?? null,
      observed_safe_for_work: 'safe_for_work' in c ? 1 : 0,
    });
  // Re-resolve here rather than leaving it to the caller: safe_for_work is the
  // primary NSFW signal, and a signal that only takes effect when someone
  // remembers to apply it is the kind of thing that rots silently.
  if ('safe_for_work' in c) applyNsfwSignals();
}

export interface CommunitySummary extends Community {
  post_count: number;
}

export function listCommunities(): CommunitySummary[] {
  return all<CommunitySummary>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM comments cm
              WHERE cm.community_address = c.address AND cm.depth = 0
                AND cm.pending_approval = 0 AND cm.removed = 0 AND cm.deleted = 0 AND cm.takedown = 0) AS post_count
       FROM communities c
       ORDER BY post_count DESC, c.address ASC`,
  );
}

export function getCommunity(address: string): CommunitySummary | undefined {
  return one<CommunitySummary>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM comments cm
              WHERE cm.community_address = c.address AND cm.depth = 0
                AND cm.pending_approval = 0 AND cm.removed = 0 AND cm.deleted = 0 AND cm.takedown = 0) AS post_count
       FROM communities c WHERE c.address = @address`,
    { address },
  );
}

// ── NSFW signals ─────────────────────────────────────────────────────────────

/**
 * `community.features.safeForWork` is the protocol's own, owner-declared answer
 * to "is this community NSFW?" — optional, so genuinely three-state. Four
 * signals resolve one community, most authoritative first:
 *
 *   1. `override`             — the operator's own file (NSFW_OVERRIDES_SOURCE,
 *      see ../nsfw.ts). States NSFW *and* not-NSFW, so a bad verdict is fixable.
 *   2. `safeForWork`          — the community's `features.safeForWork`, as the
 *      crawler last saw it. The owner's own declaration.
 *   3. `directorySafeForWork` — the `features.safeForWork` of the directory the
 *      address is listed under (DIRECTORY_DEFAULTS_SOURCE), for a community
 *      whose owner never set the feature.
 *   4. `inferred`             — any indexed comment carries the protocol's
 *      `nsfw` flag, so the community accepts NSFW content.
 *
 * Signals 2 and 3 are held in `safeForWork` polarity all the way here, exactly
 * like 5chan does: `undefined` (never declared) has to stay distinguishable
 * from `true`, so it can fall through to the next signal instead of being read
 * as either verdict.
 */
export interface NsfwSignals {
  override?: boolean;
  safeForWork?: boolean;
  directorySafeForWork?: boolean;
  inferred: boolean;
}

/** The one inversion point: `safeForWork === false` is what "NSFW" means. */
const notSafeForWork = (safeForWork: boolean | undefined): boolean | undefined =>
  safeForWork === undefined ? undefined : !safeForWork;

/** Precedence lives here and nowhere else: first signal with an opinion wins. */
export function resolveNsfw(signals: NsfwSignals): boolean {
  return (
    signals.override ??
    notSafeForWork(signals.safeForWork) ??
    notSafeForWork(signals.directorySafeForWork) ??
    signals.inferred
  );
}

/** Operator override entry: forces one community NSFW or explicitly not-NSFW. */
export interface NsfwOverride {
  address: string;
  nsfw: boolean;
  reason: string | null;
}

/**
 * Signals 1 and 3, held in memory so either can be replaced on its own. Signal 2
 * lives in the communities table instead, written by the crawl that observed it.
 */
let nsfwOverrides = new Map<string, boolean>();
let directorySafeForWork = new Map<string, boolean>();

/** A stored `safe_for_work` cell back as the three-state flag it represents. */
const storedSafeForWork = (value: number | null): boolean | undefined =>
  value === null ? undefined : value === 1;

/**
 * Recompute every community's resolved `nsfw` column from the current signals.
 * Cheap enough to run whenever any of them changes: the inference query reads
 * the partial index over flagged comments, and instances index tens of
 * communities, not millions.
 */
export function applyNsfwSignals(): void {
  const database = getDb();
  const inferred = new Set(
    (
      database
        .prepare('SELECT DISTINCT community_address AS address FROM comments WHERE nsfw = 1')
        .all() as { address: string }[]
    ).map((r) => r.address),
  );
  const rows = database.prepare('SELECT address, nsfw, safe_for_work FROM communities').all() as {
    address: string;
    nsfw: number;
    safe_for_work: number | null;
  }[];
  const update = database.prepare('UPDATE communities SET nsfw = @nsfw WHERE address = @address');

  database.transaction(() => {
    for (const row of rows) {
      const next = resolveNsfw({
        override: nsfwOverrides.get(row.address),
        safeForWork: storedSafeForWork(row.safe_for_work),
        directorySafeForWork: directorySafeForWork.get(row.address),
        inferred: inferred.has(row.address),
      })
        ? 1
        : 0;
      if (next !== row.nsfw) update.run({ address: row.address, nsfw: next });
    }
  })();
}

/** Apply operator overrides (see ../nsfw.ts for the file loader). */
export function setNsfwOverrides(entries: NsfwOverride[]): void {
  nsfwOverrides = new Map(entries.map((e) => [e.address, e.nsfw]));
  applyNsfwSignals();
}

/**
 * Apply the directory-level `features.safeForWork` flags, already joined to
 * addresses (see crawler/crawler.ts). An address listed under two directories
 * takes the stricter verdict — one NSFW directory is enough to keep it out of a
 * safe-default search.
 */
export function setDirectorySafeForWork(entries: { address: string; safeForWork: boolean }[]): void {
  const next = new Map<string, boolean>();
  for (const { address, safeForWork } of entries) next.set(address, (next.get(address) ?? true) && safeForWork);
  directorySafeForWork = next;
  applyNsfwSignals();
}

// ── posts / threads ──────────────────────────────────────────────────────────

export interface PostPage {
  posts: ServedComment[];
  page: number;
  limit: number;
  total: number;
}

/**
 * The narrowing every listing and search shares. `visibility` is the base row
 * filter: VISIBLE (no tombstones) for listings and text search, NOT_PENDING for
 * the one lookup that serves tombstones on purpose (see searchPosts).
 */
function buildFilters(o: ListOpts, visibility = VISIBLE): { where: string[]; params: Record<string, unknown> } {
  const where = [visibility];
  const params: Record<string, unknown> = {};
  if (!o.includeReplies) where.push('c.depth = 0');
  if (o.nsfw === false) where.push(NOT_NSFW);
  if (o.community) {
    where.push('c.community_address = @community');
    params.community = o.community;
  }
  if (o.time && o.time !== 'all') {
    where.push('c.timestamp >= @since');
    params.since = nowSec() - TIME_WINDOW[o.time];
  }
  return { where, params };
}

export function listPosts(o: ListOpts = {}): PostPage {
  const limit = Math.min(Math.max(o.limit ?? 25, 1), 100);
  const page = Math.max(o.page ?? 1, 1);
  const offset = (page - 1) * limit;
  const { where, params } = buildFilters(o);
  const w = where.join(' AND ');
  const order = ORDER_BY[o.sort ?? 'new'];
  const posts = all<ServedComment>(
    `${SERVED_SELECT} WHERE ${w} ORDER BY ${order} LIMIT @limit OFFSET @offset`,
    { ...params, limit, offset },
  );
  const total =
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM comments c ${JOIN_COMMUNITY} WHERE ${w}`, params)?.n ?? 0;
  return { posts: posts.map(serve), page, limit, total };
}

export interface Thread {
  post: ServedComment;
  replies: ServedComment[];
}

/**
 * Threads are served forever, even after they disappear upstream (that's the
 * point of the archive). Removed/deleted comments come back as redacted
 * tombstones; only pending-approval rows are hidden entirely.
 */
export function getThread(cid: string): Thread | null {
  const post = one<ServedComment>(`${SERVED_SELECT} WHERE c.cid = @cid AND ${NOT_PENDING}`, { cid });
  if (!post) return null;
  const replies = all<ServedComment>(
    `${SERVED_SELECT}
      WHERE c.post_cid = @root AND c.cid != @root AND ${NOT_PENDING}
      ORDER BY c.timestamp ASC`,
    { root: post.post_cid },
  );
  return { post: serve(post), replies: replies.map(serve) };
}

// ── operator takedown blocklist ──────────────────────────────────────────────

export type BlocklistScope = 'comment' | 'thread';

export interface BlocklistEntry {
  cid: string;
  /** "comment" redacts one comment; "thread" redacts a post AND all its replies. */
  scope: BlocklistScope;
  reason: string | null;
}

/** The active blocklist, kept in memory so ingest can consult it per comment. */
let blocklist = new Map<string, BlocklistEntry>();

/** The entry redacting this comment, if any (its own CID, or its thread's root). */
function blockedBy(cid: string, postCid: string): BlocklistEntry | undefined {
  const own = blocklist.get(cid);
  if (own) return own;
  const root = blocklist.get(postCid);
  return root?.scope === 'thread' ? root : undefined;
}

/**
 * Apply the operator blocklist (see ../blocklist.ts for the file loader).
 * Same serve-time redaction as removed/deleted tombstones, but operator-owned
 * and fully reversible: content columns are never touched — only the `takedown`
 * flag and the FTS index. Rows whose entry disappeared from the list are
 * restored (flag cleared, FTS re-indexed from the stored content).
 */
export function setBlocklist(entries: BlocklistEntry[]): void {
  blocklist = new Map(entries.map((e) => [e.cid, e]));
  const database = getDb();
  const deleteFts = database.prepare('DELETE FROM comments_fts WHERE cid = ?');
  const insertFts = database.prepare(
    'INSERT INTO comments_fts (cid, title, content, author_name) VALUES (@cid, @title, @content, @author_name)',
  );
  const redact = database.prepare(
    'UPDATE comments SET takedown = 1, takedown_reason = @reason WHERE cid = @cid',
  );
  const restore = database.prepare(
    'UPDATE comments SET takedown = 0, takedown_reason = NULL WHERE cid = ?',
  );

  database.transaction(() => {
    // Restore rows that are no longer matched by any entry.
    const taken = database
      .prepare(
        `SELECT cid, post_cid, title, content, author_name, pending_approval, removed, deleted
           FROM comments WHERE takedown = 1`,
      )
      .all() as Pick<
      Comment,
      'cid' | 'post_cid' | 'title' | 'content' | 'author_name' | 'pending_approval' | 'removed' | 'deleted'
    >[];
    for (const row of taken) {
      if (blockedBy(row.cid, row.post_cid)) continue;
      restore.run(row.cid);
      // Back into search — unless the row is a tombstone for other reasons.
      if (!row.pending_approval && !row.removed && !row.deleted) {
        deleteFts.run(row.cid); // defensive: never double-index
        insertFts.run({ cid: row.cid, title: row.title, content: row.content, author_name: row.author_name });
      }
    }

    // Redact everything the blocklist matches (idempotent on re-application).
    for (const e of entries) {
      const targets = database
        .prepare(
          e.scope === 'thread'
            ? 'SELECT cid FROM comments WHERE cid = @cid OR post_cid = @cid'
            : 'SELECT cid FROM comments WHERE cid = @cid',
        )
        .all({ cid: e.cid }) as { cid: string }[];
      for (const t of targets) {
        redact.run({ cid: t.cid, reason: e.reason });
        deleteFts.run(t.cid);
      }
    }
  })();
}

// ── search ───────────────────────────────────────────────────────────────────

/**
 * Turn raw user input into a safe FTS5 MATCH expression (AND of prefix terms).
 * `column` restricts every term to one FTS column, which is how `selftext`
 * searches the body alone; `:` is among the stripped characters, so user input
 * can never open a column filter of its own.
 */
function toFtsQuery(q: string, column?: 'content'): string {
  const prefix = column ? `${column}:` : '';
  return q
    .replace(/["()*:^]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `${prefix}"${t}"*`)
    .join(' ');
}

/** Free text and `selftext` share one MATCH expression, ANDed together. */
function toMatch(o: { q?: string; selftext?: string }): string {
  return [toFtsQuery(o.q ?? ''), toFtsQuery(o.selftext ?? '', 'content')].filter(Boolean).join(' ');
}

/** A URL's host, lowercased — NULL for anything that will not parse as a URL. */
function linkHost(link: string | null): string | null {
  if (!link) return null;
  try {
    return new URL(link).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * `site` normally arrives as a bare domain, but a pasted URL has to work too, so
 * both go through the same parser (which also handles case, ports, paths and
 * IDN). Input that will not parse is kept as typed rather than dropped: a filter
 * that quietly disappears would widen the results instead of narrowing them.
 */
function normalizeSite(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  return linkHost(raw.includes('://') ? raw : `https://${raw}`) ?? raw.toLowerCase();
}

/** A LIKE pattern matching `value` anywhere, with LIKE's wildcards escaped. */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Address or display name, either one, exactly — see SearchFilters.author. */
const AUTHOR_SQL =
  '(c.author_address = @author COLLATE NOCASE OR c.author_name = @author COLLATE NOCASE)';

/**
 * Host equality, plus a dot-anchored suffix test for subdomains. The suffix is
 * compared with substr/= rather than LIKE so the domain cannot carry wildcards,
 * and the leading '.' is what stops `notexample.com` matching `example.com`.
 */
const SITE_SQL = `(link_host(c.link) = @site
     OR substr(link_host(c.link), -(length(@site) + 1)) = '.' || @site)`;

/** Substring of the link — necessarily unindexed, unlike SITE_SQL's equality. */
const URL_SQL = "c.link LIKE @url ESCAPE '\\'";

/** A post is a text post when it carries no link, a link post when it does. */
const SELF_POST = "(c.link IS NULL OR c.link = '')";
const LINK_POST = "(c.link IS NOT NULL AND c.link != '')";

/**
 * The advanced filters as WHERE terms. `selftext` is absent on purpose: it is
 * part of the MATCH expression (see toMatch), not a column filter.
 */
function buildSearchFilters(o: SearchFilters): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  const author = o.author?.trim();
  if (author) {
    where.push(AUTHOR_SQL);
    params.author = author;
  }
  const site = normalizeSite(o.site ?? '');
  if (site) {
    where.push(SITE_SQL);
    params.site = site;
  }
  const url = o.url?.trim();
  if (url) {
    where.push(URL_SQL);
    params.url = likeContains(url);
  }
  if (o.self === 'yes') where.push(SELF_POST);
  if (o.self === 'no') where.push(LINK_POST);
  return { where, params };
}

/**
 * `q` when the whole of it is one CID, in canonical string form; undefined for
 * anything else. A comment CID pasted into a search box is one long opaque
 * token the FTS index can never match, so searchPosts looks it up by
 * `comments.cid` instead. Recognised by parsing, not by pattern: CIDv0 (`Qm…`,
 * base58btc) and CIDv1 (`bafy…` base32, plus the `z…`/`k…` multibase forms) are
 * accepted by structure — alphabet, varints, digest length — so an ordinary
 * word never is (checked against a 236k-word dictionary: no hits). The
 * mixed-input rule is deliberately strict: a CID with other words around it is
 * a text search, exactly as before. A CID names one comment, so extra words
 * could only narrow it to nothing, and guessing which half the user meant would
 * make the answer depend on the tokenizer. The canonical form is what the
 * network hands the crawler and so what is stored, hence what is compared —
 * the same CID typed in another multibase (`z…`) still finds it.
 */
function parseCid(q: string | undefined): string | undefined {
  const raw = q?.trim();
  if (!raw || /\s/.test(raw)) return undefined;
  try {
    return CID.parse(raw).toString();
  } catch {
    return undefined;
  }
}

export function searchPosts(o: ListOpts & SearchFilters & { q?: string }): PostPage {
  const cid = parseCid(o.q);
  // A CID is not text: it takes q's place as an exact `comments.cid` term and
  // never reaches the FTS index. `selftext` still does, and still narrows.
  const match = toMatch({ q: cid ? undefined : o.q, selftext: o.selftext });
  const filters = buildSearchFilters(o);
  // Nothing to search on. `community`/`time`/`nsfw` narrow a search rather than
  // being one, so they still land here — but any content filter makes an empty
  // `q` a real query, which is what `author:lena.bso` with no words has to mean.
  if (!cid && !match && filters.where.length === 0) return { posts: [], page: 1, limit: o.limit ?? 25, total: 0 };

  const limit = Math.min(Math.max(o.limit ?? 25, 1), 100);
  const page = Math.max(o.page ?? 1, 1);
  const offset = (page - 1) * limit;

  // Text search hides tombstones: they have no content to match. A comment
  // asked for by its CID is served the way /api/posts/:cid serves it — the same
  // NOT_PENDING filter, the same `serve` redaction — so pending-approval rows
  // never appear and a removed/deleted/taken-down one comes back as its
  // tombstone: the answer to "this exact comment" is "removed", not "no such
  // comment". Only for the bare lookup, though. `author`/`site`/`url`/`self`/
  // `selftext` compare columns the tombstone redacts, and a yes/no answer over
  // redacted content would be a side channel around the blocklist, so with any
  // of them set tombstones stay hidden exactly as in text search.
  const bare = cid !== undefined && !match && filters.where.length === 0;
  const { where, params } = buildFilters(o, bare ? NOT_PENDING : VISIBLE);
  if (cid) {
    where.push('c.cid = @cid');
    params.cid = cid;
  }
  // One AND-ed list: every filter narrows the previous ones instead of
  // replacing them, and the same list is reused for the total.
  where.push(...filters.where);
  Object.assign(params, filters.params);
  const w = where.join(' AND ');

  // With text to match, FTS drives the query and the filters narrow its rows.
  // With filters alone there is nothing to MATCH, so this degrades to the same
  // filtered scan /api/posts already runs — and relevance has nothing to rank,
  // hence newest-first.
  const from = match
    ? `comments_fts f JOIN comments c ON c.cid = f.cid ${JOIN_COMMUNITY}`
    : `comments c ${JOIN_COMMUNITY}`;
  const matched = match ? 'comments_fts MATCH @match AND ' : '';
  if (match) params.match = match;
  // 'top'/'replies'/'new'/'old' sort, defaulting to FTS relevance where there is any.
  const order = match ? (o.sort ? ORDER_BY[o.sort] : 'f.rank') : ORDER_BY[o.sort ?? 'new'];

  const posts = all<ServedComment>(
    `SELECT c.*, ${ARCHIVED_SQL} AS archived FROM ${from}
      WHERE ${matched}${w}
      ORDER BY ${order} LIMIT @limit OFFSET @offset`,
    { ...params, limit, offset },
  );
  const total =
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${from} WHERE ${matched}${w}`, params)?.n ?? 0;
  return { posts: posts.map(serve), page, limit, total };
}

// ── writes (used by the crawler / seed) ──────────────────────────────────────

export interface CommentInput {
  cid: string;
  community_address: string;
  post_cid: string;
  depth: number;
  timestamp: number;
  parent_cid?: string | null;
  author_address?: string | null;
  author_name?: string | null;
  title?: string | null;
  content?: string | null;
  link?: string | null;
  thumbnail_url?: string | null;
  upvote_count?: number;
  downvote_count?: number;
  reply_count?: number;
  raw?: string | null;
  indexed_at?: number;
  first_seen_at?: number;
  last_seen_at?: number;
  pending_approval?: boolean;
  removed?: boolean;
  deleted?: boolean;
  mod_reason?: string | null;
  upstream_archived?: boolean;
  nsfw?: boolean;
}

/**
 * Ingest crawled comments. Archive-forever semantics:
 *
 * - Rows are inserted once and never deleted; re-crawls only refresh mutable
 *   state (votes, reply counts, moderation flags, last_seen_at).
 * - Content fields are only ever COALESCEd — an upstream update can never blank
 *   out content we already archived.
 * - `pending_approval` (mod-queue) comments are never inserted. If an update
 *   flags an already-indexed comment as pending, the row is kept but stops
 *   being served (and leaves the FTS index).
 * - removed/deleted comments stay as rows (tombstones) but leave the FTS index.
 * - blocklisted CIDs (operator takedown) are marked on insert and never enter
 *   the FTS index — re-crawling cannot resurrect a takedown.
 * - `nsfw` only ever ratchets up, so a page that omits the flag cannot quietly
 *   un-flag a comment (and with it its community's inferred verdict).
 *
 * Returns the number of newly inserted comments.
 */
export function insertComments(rows: CommentInput[]): number {
  const database = getDb();
  const selectPrior = database.prepare(
    'SELECT community_address, pending_approval, removed, deleted, takedown FROM comments WHERE cid = ?',
  );
  const moveCommunityArchive = database.prepare(
    'UPDATE comments SET community_address = @next WHERE community_address = @prior',
  );
  const insert = database.prepare(
    `INSERT INTO comments
       (cid, community_address, post_cid, parent_cid, depth, timestamp,
        author_address, author_name, title, content, link, thumbnail_url,
        upvote_count, downvote_count, reply_count, raw, indexed_at, removed_at,
        first_seen_at, last_seen_at, pending_approval, removed, deleted, mod_reason, upstream_archived,
        nsfw, takedown, takedown_reason)
     VALUES
       (@cid, @community_address, @post_cid, @parent_cid, @depth, @timestamp,
        @author_address, @author_name, @title, @content, @link, @thumbnail_url,
        @upvote_count, @downvote_count, @reply_count, @raw, @indexed_at, @removed_at,
        @first_seen_at, @last_seen_at, 0, @removed, @deleted, @mod_reason, @upstream_archived,
        @nsfw, @takedown, @takedown_reason)`,
  );
  const update = database.prepare(
    `UPDATE comments SET
        community_address = @community_address,
        upvote_count = @upvote_count,
        downvote_count = @downvote_count,
        reply_count = @reply_count,
        last_seen_at = @last_seen_at,
        pending_approval = @pending_approval,
        removed = @removed,
        deleted = @deleted,
        upstream_archived = MAX(upstream_archived, @upstream_archived),
        -- Sticky, like upstream_archived: a page that simply omits the flag must
        -- not silently un-flag content a safe-default search relies on. An
        -- operator override is how a wrong NSFW verdict gets corrected.
        nsfw = MAX(nsfw, @nsfw),
        mod_reason = COALESCE(@mod_reason, mod_reason),
        title = COALESCE(@title, title),
        content = COALESCE(@content, content),
        link = COALESCE(@link, link),
        thumbnail_url = COALESCE(@thumbnail_url, thumbnail_url),
        author_address = COALESCE(@author_address, author_address),
        author_name = COALESCE(@author_name, author_name),
        raw = COALESCE(@raw, raw),
        removed_at = CASE WHEN @removed = 1 OR @deleted = 1 OR @pending_approval = 1
                          THEN COALESCE(removed_at, @now) ELSE NULL END
      WHERE cid = @cid`,
  );
  const insertFts = database.prepare(
    'INSERT INTO comments_fts (cid, title, content, author_name) VALUES (@cid, @title, @content, @author_name)',
  );
  const deleteFts = database.prepare('DELETE FROM comments_fts WHERE cid = ?');
  const selectStored = database.prepare('SELECT title, content, author_name FROM comments WHERE cid = ?');

  const tx = database.transaction((items: CommentInput[]) => {
    let inserted = 0;
    const now = nowSec();
    for (const r of items) {
      const pending = r.pending_approval ? 1 : 0;
      const removed = r.removed ? 1 : 0;
      const deleted = r.deleted ? 1 : 0;
      const seenAt = r.last_seen_at ?? now;
      const row = {
        cid: r.cid,
        community_address: r.community_address,
        post_cid: r.post_cid,
        depth: r.depth,
        timestamp: r.timestamp,
        parent_cid: r.parent_cid ?? null,
        author_address: r.author_address ?? null,
        author_name: r.author_name ?? null,
        title: r.title ?? null,
        content: r.content ?? null,
        link: r.link ?? null,
        thumbnail_url: r.thumbnail_url ?? null,
        upvote_count: r.upvote_count ?? 0,
        downvote_count: r.downvote_count ?? 0,
        reply_count: r.reply_count ?? 0,
        raw: r.raw ?? null,
        pending_approval: pending,
        removed,
        deleted,
        mod_reason: r.mod_reason ?? null,
        upstream_archived: r.upstream_archived ? 1 : 0,
        nsfw: r.nsfw ? 1 : 0,
        last_seen_at: seenAt,
        now,
      };

      const prior = selectPrior.get(r.cid) as
        | { community_address: string; pending_approval: number; removed: number; deleted: number; takedown: number }
        | undefined;
      if (prior && prior.community_address !== r.community_address) {
        // Seeing any still-live row through a canonical alias proves that the
        // complete archive under its previous address belongs here too.
        moveCommunityArchive.run({ prior: prior.community_address, next: r.community_address });
      }
      const blocked = blockedBy(r.cid, row.post_cid);

      if (!prior) {
        // Mod-queue content is never indexed. When it's later approved and
        // shows up normally, it gets inserted like any other comment.
        if (pending) continue;
        insert.run({
          ...row,
          indexed_at: r.indexed_at ?? now,
          first_seen_at: r.first_seen_at ?? seenAt,
          removed_at: removed || deleted ? now : null,
          takedown: blocked ? 1 : 0,
          takedown_reason: blocked?.reason ?? null,
        });
        if (!removed && !deleted && !blocked) {
          insertFts.run({ cid: row.cid, title: row.title, content: row.content, author_name: row.author_name });
        }
        inserted++;
        continue;
      }

      update.run(row);
      const wasServable = !prior.pending_approval && !prior.removed && !prior.deleted && !prior.takedown;
      const isServable = !pending && !removed && !deleted && !blocked && !prior.takedown;
      if (wasServable && !isServable) {
        deleteFts.run(r.cid);
      } else if (!wasServable && isServable) {
        const stored = selectStored.get(r.cid) as Pick<Comment, 'title' | 'content' | 'author_name'>;
        deleteFts.run(r.cid); // defensive: never double-index
        insertFts.run({ cid: r.cid, title: stored.title, content: stored.content, author_name: stored.author_name });
      }
    }
    return inserted;
  });
  return tx(rows);
}

export interface Stats {
  communities: number;
  posts: number;
  replies: number;
  lastIndexedAt: number | null;
}

export function stats(): Stats {
  const visible = 'pending_approval = 0 AND removed = 0 AND deleted = 0 AND takedown = 0';
  return {
    communities: one<{ n: number }>('SELECT COUNT(*) AS n FROM communities')?.n ?? 0,
    posts: one<{ n: number }>(`SELECT COUNT(*) AS n FROM comments WHERE depth = 0 AND ${visible}`)?.n ?? 0,
    replies: one<{ n: number }>(`SELECT COUNT(*) AS n FROM comments WHERE depth > 0 AND ${visible}`)?.n ?? 0,
    lastIndexedAt: one<{ t: number | null }>('SELECT MAX(last_indexed_at) AS t FROM communities')?.t ?? null,
  };
}
