-- bitsocial-indexer schema. Posts and replies live in one flattened `comments`
-- table (depth 0 = thread/original post, depth > 0 = reply), mirroring how the
-- network models comments. Full-text search is a separate FTS5 table kept in
-- sync by the DB layer.

CREATE TABLE IF NOT EXISTS communities (
  address          TEXT PRIMARY KEY,           -- e.g. "art.bso" or an IPNS/ENS address
  title            TEXT,
  description      TEXT,
  added_at         INTEGER NOT NULL,           -- unix seconds
  last_indexed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS comments (
  cid               TEXT PRIMARY KEY,          -- content id of this comment
  community_address TEXT NOT NULL,
  post_cid          TEXT NOT NULL,             -- root of the thread (== cid for an OP)
  parent_cid        TEXT,                      -- direct parent (NULL for an OP)
  depth             INTEGER NOT NULL DEFAULT 0,
  timestamp         INTEGER NOT NULL,          -- unix seconds, author-claimed
  author_address    TEXT,
  author_name       TEXT,
  title             TEXT,                      -- OPs only
  content           TEXT,
  link              TEXT,                      -- attached url / media
  thumbnail_url     TEXT,
  upvote_count      INTEGER NOT NULL DEFAULT 0,
  downvote_count    INTEGER NOT NULL DEFAULT 0,
  reply_count       INTEGER NOT NULL DEFAULT 0,
  raw               TEXT,                      -- full source comment as JSON
  indexed_at        INTEGER NOT NULL,
  removed_at        INTEGER                    -- soft-delete / moderation
);

CREATE INDEX IF NOT EXISTS idx_comments_community ON comments(community_address);
CREATE INDEX IF NOT EXISTS idx_comments_timestamp ON comments(timestamp);
CREATE INDEX IF NOT EXISTS idx_comments_post      ON comments(post_cid);
CREATE INDEX IF NOT EXISTS idx_comments_parent    ON comments(parent_cid);

-- Full-text index. `cid` is stored but not tokenized so we can join back.
CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
  cid UNINDEXED,
  title,
  content,
  author_name,
  tokenize = 'porter unicode61'
);

-- Per-community crawl scheduling + retry bookkeeping.
CREATE TABLE IF NOT EXISTS crawl_queue (
  community_address TEXT PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'queued',  -- queued | running | success | failed
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_success_at   INTEGER,
  last_error        TEXT,
  next_run_at       INTEGER
);
