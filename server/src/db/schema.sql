-- bitsocial-indexer schema. Posts and replies live in one flattened `comments`
-- table (depth 0 = thread/original post, depth > 0 = reply), mirroring how the
-- network models comments. Full-text search is a separate FTS5 table kept in
-- sync by the DB layer.

CREATE TABLE IF NOT EXISTS communities (
  address          TEXT PRIMARY KEY,           -- e.g. "art.bso" or an IPNS/ENS address
  title            TEXT,
  description      TEXT,
  added_at         INTEGER NOT NULL,           -- unix seconds
  last_indexed_at  INTEGER,
  -- The protocol's own community.features.safeForWork, as the last crawl saw
  -- it. Optional on the wire, so three-state here too: 1 = declared safe for
  -- work, 0 = declared NSFW, NULL = the owner never declared either way.
  safe_for_work    INTEGER,
  -- Resolved NSFW flag, derived from four signals (operator override >
  -- safe_for_work above > directory list > inference from flagged comments) —
  -- see resolveNsfw / applyNsfwSignals in db/index.ts.
  nsfw             INTEGER NOT NULL DEFAULT 0
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
  removed_at        INTEGER,                   -- when we first saw the removed/deleted flag
  -- Archive bookkeeping: when the crawler first/last saw this comment upstream.
  first_seen_at     INTEGER,
  last_seen_at      INTEGER,
  -- Moderation state (from the comment / its CommentUpdate). Rows are NEVER
  -- deleted: removed/deleted content is kept but redacted when served
  -- (tombstone), pending_approval rows are never served at all.
  pending_approval  INTEGER NOT NULL DEFAULT 0,
  removed           INTEGER NOT NULL DEFAULT 0, -- mod-removed
  deleted           INTEGER NOT NULL DEFAULT 0, -- author-deleted
  mod_reason        TEXT,
  upstream_archived INTEGER NOT NULL DEFAULT 0, -- explicit `archived` flag in a CommentUpdate
  -- The protocol's per-comment `nsfw` flag (author- or mod-set). Also the raw
  -- material for inferring whether the whole community accepts NSFW content.
  nsfw              INTEGER NOT NULL DEFAULT 0,
  -- Operator takedown (local blocklist, see BLOCKLIST_SOURCE). Reversible
  -- serve-time redaction: content columns are never destroyed, only this flag
  -- (plus FTS membership) toggles.
  takedown          INTEGER NOT NULL DEFAULT 0,
  takedown_reason   TEXT
);

CREATE INDEX IF NOT EXISTS idx_comments_community ON comments(community_address);
CREATE INDEX IF NOT EXISTS idx_comments_timestamp ON comments(timestamp);
CREATE INDEX IF NOT EXISTS idx_comments_post      ON comments(post_cid);
CREATE INDEX IF NOT EXISTS idx_comments_parent    ON comments(parent_cid);
-- idx_comments_nsfw (partial, over the flagged rows only) is created by
-- migrate() instead: this file runs before the migration that adds
-- comments.nsfw to a pre-existing archive, so the index cannot reference it yet.

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
  next_run_at       INTEGER,
  started_at        INTEGER                          -- when the current 'running' pass claimed the row
);
