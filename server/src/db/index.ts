import Database from 'better-sqlite3';
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

const SERVED_SELECT = `SELECT c.*, ${ARCHIVED_SQL} AS archived
   FROM comments c LEFT JOIN communities m ON m.address = c.community_address`;

/** Filter applied to every listing/search: mod-queue content is never served. */
const NOT_PENDING = 'c.pending_approval = 0';
/** Listings and search additionally hide tombstones (they have no content). */
const VISIBLE = `${NOT_PENDING} AND c.removed = 0 AND c.deleted = 0`;

const nowSec = () => Math.floor(Date.now() / 1000);

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (db) return db;
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/** Additive migrations for databases created before a column existed in schema.sql. */
function migrate(database: Database.Database): void {
  const columns: Record<string, string> = {
    first_seen_at: 'INTEGER',
    last_seen_at: 'INTEGER',
    pending_approval: 'INTEGER NOT NULL DEFAULT 0',
    removed: 'INTEGER NOT NULL DEFAULT 0',
    deleted: 'INTEGER NOT NULL DEFAULT 0',
    mod_reason: 'TEXT',
    upstream_archived: 'INTEGER NOT NULL DEFAULT 0',
  };
  const existing = new Set((database.pragma(`table_info('comments')`) as { name: string }[]).map((c) => c.name));
  let added = false;
  for (const [name, type] of Object.entries(columns)) {
    if (existing.has(name)) continue;
    database.exec(`ALTER TABLE comments ADD COLUMN ${name} ${type}`);
    added = true;
  }
  if (added) {
    // Backfill seen-times for rows indexed before the columns existed.
    database.exec('UPDATE comments SET first_seen_at = indexed_at WHERE first_seen_at IS NULL');
    database.exec('UPDATE comments SET last_seen_at = indexed_at WHERE last_seen_at IS NULL');
  }
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
 * Tombstone redaction: removed (mod) / deleted (author) comments keep their row
 * so thread structure survives, but their content is never served.
 */
function serve(row: ServedComment): ServedComment {
  if (!row.removed && !row.deleted) return row;
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

export function upsertCommunity(c: Pick<Community, 'address'> & Partial<Community>): void {
  getDb()
    .prepare(
      `INSERT INTO communities (address, title, description, added_at, last_indexed_at)
       VALUES (@address, @title, @description, @added_at, @last_indexed_at)
       ON CONFLICT(address) DO UPDATE SET
         title = COALESCE(excluded.title, communities.title),
         description = COALESCE(excluded.description, communities.description),
         last_indexed_at = COALESCE(excluded.last_indexed_at, communities.last_indexed_at)`,
    )
    .run({
      address: c.address,
      title: c.title ?? null,
      description: c.description ?? null,
      added_at: c.added_at ?? nowSec(),
      last_indexed_at: c.last_indexed_at ?? null,
    });
}

export interface CommunitySummary extends Community {
  post_count: number;
}

export function listCommunities(): CommunitySummary[] {
  return all<CommunitySummary>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM comments cm
              WHERE cm.community_address = c.address AND cm.depth = 0
                AND cm.pending_approval = 0 AND cm.removed = 0 AND cm.deleted = 0) AS post_count
       FROM communities c
       ORDER BY post_count DESC, c.address ASC`,
  );
}

export function getCommunity(address: string): CommunitySummary | undefined {
  return one<CommunitySummary>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM comments cm
              WHERE cm.community_address = c.address AND cm.depth = 0
                AND cm.pending_approval = 0 AND cm.removed = 0 AND cm.deleted = 0) AS post_count
       FROM communities c WHERE c.address = @address`,
    { address },
  );
}

// ── posts / threads ──────────────────────────────────────────────────────────

export interface PostPage {
  posts: ServedComment[];
  page: number;
  limit: number;
  total: number;
}

function buildFilters(o: ListOpts): { where: string[]; params: Record<string, unknown> } {
  const where = [VISIBLE];
  const params: Record<string, unknown> = {};
  if (!o.includeReplies) where.push('c.depth = 0');
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
  const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM comments c WHERE ${w}`, params)?.n ?? 0;
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

// ── search ───────────────────────────────────────────────────────────────────

/** Turn raw user input into a safe FTS5 MATCH expression (AND of prefix terms). */
function toFtsQuery(q: string): string {
  return q
    .replace(/["()*:^]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(' ');
}

export function searchPosts(o: ListOpts & { q: string }): PostPage {
  const match = toFtsQuery(o.q);
  if (!match) return { posts: [], page: 1, limit: o.limit ?? 25, total: 0 };

  const limit = Math.min(Math.max(o.limit ?? 25, 1), 100);
  const page = Math.max(o.page ?? 1, 1);
  const offset = (page - 1) * limit;

  const { where, params } = buildFilters(o);
  params.match = match;
  const w = where.join(' AND ');
  // 'top'/'replies'/'new'/'old' sort, defaulting to FTS relevance for the default.
  const order = o.sort ? ORDER_BY[o.sort] : 'f.rank';

  const posts = all<ServedComment>(
    `SELECT c.*, ${ARCHIVED_SQL} AS archived FROM comments_fts f
       JOIN comments c ON c.cid = f.cid
       LEFT JOIN communities m ON m.address = c.community_address
      WHERE comments_fts MATCH @match AND ${w}
      ORDER BY ${order} LIMIT @limit OFFSET @offset`,
    { ...params, limit, offset },
  );
  const total =
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM comments_fts f
         JOIN comments c ON c.cid = f.cid
        WHERE comments_fts MATCH @match AND ${w}`,
      params,
    )?.n ?? 0;
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
 *
 * Returns the number of newly inserted comments.
 */
export function insertComments(rows: CommentInput[]): number {
  const database = getDb();
  const selectPrior = database.prepare(
    'SELECT pending_approval, removed, deleted FROM comments WHERE cid = ?',
  );
  const insert = database.prepare(
    `INSERT INTO comments
       (cid, community_address, post_cid, parent_cid, depth, timestamp,
        author_address, author_name, title, content, link, thumbnail_url,
        upvote_count, downvote_count, reply_count, raw, indexed_at, removed_at,
        first_seen_at, last_seen_at, pending_approval, removed, deleted, mod_reason, upstream_archived)
     VALUES
       (@cid, @community_address, @post_cid, @parent_cid, @depth, @timestamp,
        @author_address, @author_name, @title, @content, @link, @thumbnail_url,
        @upvote_count, @downvote_count, @reply_count, @raw, @indexed_at, @removed_at,
        @first_seen_at, @last_seen_at, 0, @removed, @deleted, @mod_reason, @upstream_archived)`,
  );
  const update = database.prepare(
    `UPDATE comments SET
        upvote_count = @upvote_count,
        downvote_count = @downvote_count,
        reply_count = @reply_count,
        last_seen_at = @last_seen_at,
        pending_approval = @pending_approval,
        removed = @removed,
        deleted = @deleted,
        upstream_archived = MAX(upstream_archived, @upstream_archived),
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
        last_seen_at: seenAt,
        now,
      };

      const prior = selectPrior.get(r.cid) as
        | { pending_approval: number; removed: number; deleted: number }
        | undefined;

      if (!prior) {
        // Mod-queue content is never indexed. When it's later approved and
        // shows up normally, it gets inserted like any other comment.
        if (pending) continue;
        insert.run({
          ...row,
          indexed_at: r.indexed_at ?? now,
          first_seen_at: r.first_seen_at ?? seenAt,
          removed_at: removed || deleted ? now : null,
        });
        if (!removed && !deleted) {
          insertFts.run({ cid: row.cid, title: row.title, content: row.content, author_name: row.author_name });
        }
        inserted++;
        continue;
      }

      update.run(row);
      const wasServable = !prior.pending_approval && !prior.removed && !prior.deleted;
      const isServable = !pending && !removed && !deleted;
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
  const visible = 'pending_approval = 0 AND removed = 0 AND deleted = 0';
  return {
    communities: one<{ n: number }>('SELECT COUNT(*) AS n FROM communities')?.n ?? 0,
    posts: one<{ n: number }>(`SELECT COUNT(*) AS n FROM comments WHERE depth = 0 AND ${visible}`)?.n ?? 0,
    replies: one<{ n: number }>(`SELECT COUNT(*) AS n FROM comments WHERE depth > 0 AND ${visible}`)?.n ?? 0,
    lastIndexedAt: one<{ t: number | null }>('SELECT MAX(last_indexed_at) AS t FROM communities')?.t ?? null,
  };
}
