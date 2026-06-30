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
  new: 'timestamp DESC',
  old: 'timestamp ASC',
  top: '(upvote_count - downvote_count) DESC, timestamp DESC',
  replies: 'reply_count DESC, timestamp DESC',
};

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
  return db;
}

function all<T>(sql: string, params: Record<string, unknown> = {}): T[] {
  const stmt = getDb().prepare(sql);
  return (Object.keys(params).length ? stmt.all(params) : stmt.all()) as T[];
}

function one<T>(sql: string, params: Record<string, unknown> = {}): T | undefined {
  const stmt = getDb().prepare(sql);
  return (Object.keys(params).length ? stmt.get(params) : stmt.get()) as T | undefined;
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
              WHERE cm.community_address = c.address AND cm.depth = 0 AND cm.removed_at IS NULL) AS post_count
       FROM communities c
       ORDER BY post_count DESC, c.address ASC`,
  );
}

export function getCommunity(address: string): CommunitySummary | undefined {
  return one<CommunitySummary>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM comments cm
              WHERE cm.community_address = c.address AND cm.depth = 0 AND cm.removed_at IS NULL) AS post_count
       FROM communities c WHERE c.address = @address`,
    { address },
  );
}

// ── posts / threads ──────────────────────────────────────────────────────────

export interface PostPage {
  posts: Comment[];
  page: number;
  limit: number;
  total: number;
}

function buildFilters(o: ListOpts): { where: string[]; params: Record<string, unknown> } {
  const where = ['removed_at IS NULL'];
  const params: Record<string, unknown> = {};
  if (!o.includeReplies) where.push('depth = 0');
  if (o.community) {
    where.push('community_address = @community');
    params.community = o.community;
  }
  if (o.time && o.time !== 'all') {
    where.push('timestamp >= @since');
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
  const posts = all<Comment>(
    `SELECT * FROM comments WHERE ${w} ORDER BY ${order} LIMIT @limit OFFSET @offset`,
    { ...params, limit, offset },
  );
  const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM comments WHERE ${w}`, params)?.n ?? 0;
  return { posts, page, limit, total };
}

export interface Thread {
  post: Comment;
  replies: Comment[];
}

export function getThread(cid: string): Thread | null {
  const post = one<Comment>('SELECT * FROM comments WHERE cid = @cid AND removed_at IS NULL', { cid });
  if (!post) return null;
  const replies = all<Comment>(
    `SELECT * FROM comments
       WHERE post_cid = @root AND cid != @root AND removed_at IS NULL
       ORDER BY timestamp ASC`,
    { root: post.post_cid },
  );
  return { post, replies };
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

  const where = ['c.removed_at IS NULL'];
  const params: Record<string, unknown> = { match };
  if (!o.includeReplies) where.push('c.depth = 0');
  if (o.community) {
    where.push('c.community_address = @community');
    params.community = o.community;
  }
  if (o.time && o.time !== 'all') {
    where.push('c.timestamp >= @since');
    params.since = nowSec() - TIME_WINDOW[o.time];
  }
  const w = where.join(' AND ');
  // 'top'/'replies'/'new'/'old' sort, defaulting to FTS relevance for the default.
  const order = o.sort ? ORDER_BY[o.sort].replace(/\b(timestamp|upvote_count|downvote_count|reply_count)\b/g, 'c.$1') : 'f.rank';

  const posts = all<Comment>(
    `SELECT c.* FROM comments_fts f
       JOIN comments c ON c.cid = f.cid
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
  return { posts, page, limit, total };
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
}

/** Insert comments + keep FTS in sync. Returns the number newly inserted. */
export function insertComments(rows: CommentInput[]): number {
  const database = getDb();
  const insert = database.prepare(
    `INSERT OR IGNORE INTO comments
       (cid, community_address, post_cid, parent_cid, depth, timestamp,
        author_address, author_name, title, content, link, thumbnail_url,
        upvote_count, downvote_count, reply_count, raw, indexed_at, removed_at)
     VALUES
       (@cid, @community_address, @post_cid, @parent_cid, @depth, @timestamp,
        @author_address, @author_name, @title, @content, @link, @thumbnail_url,
        @upvote_count, @downvote_count, @reply_count, @raw, @indexed_at, NULL)`,
  );
  const insertFts = database.prepare(
    'INSERT INTO comments_fts (cid, title, content, author_name) VALUES (@cid, @title, @content, @author_name)',
  );
  const tx = database.transaction((items: CommentInput[]) => {
    let inserted = 0;
    for (const r of items) {
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
        indexed_at: r.indexed_at ?? nowSec(),
      };
      if (insert.run(row).changes > 0) {
        insertFts.run({ cid: row.cid, title: row.title, content: row.content, author_name: row.author_name });
        inserted++;
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
  return {
    communities: one<{ n: number }>('SELECT COUNT(*) AS n FROM communities')?.n ?? 0,
    posts: one<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE depth = 0 AND removed_at IS NULL')?.n ?? 0,
    replies: one<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE depth > 0 AND removed_at IS NULL')?.n ?? 0,
    lastIndexedAt: one<{ t: number | null }>('SELECT MAX(last_indexed_at) AS t FROM communities')?.t ?? null,
  };
}
