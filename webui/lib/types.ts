// Shapes returned by the indexer API (server/src/api).

export interface Community {
  address: string;
  title: string | null;
  description: string | null;
  added_at: number;
  last_indexed_at: number | null;
  post_count: number;
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
  indexed_at: number;
  /** 1 when the thread is no longer live upstream (served from the archive). */
  archived: 0 | 1;
  /** Tombstones: removed (mod) / deleted (author) — content fields come back null. */
  removed: 0 | 1;
  deleted: 0 | 1;
  mod_reason: string | null;
  /** Operator takedown (BLOCKLIST_SOURCE) — redacted like removed/deleted. */
  takedown: 0 | 1;
  /** Operator-side bookkeeping (e.g. "DMCA #42") — not shown in the UI. */
  takedown_reason: string | null;
}

export interface PostPage {
  posts: Comment[];
  page: number;
  limit: number;
  total: number;
}

export interface SearchResult extends PostPage {
  query: string;
}

export interface Thread {
  post: Comment;
  replies: Comment[];
}

export interface Health {
  status: string;
  site: string;
  communities: number;
  posts: number;
  replies: number;
  lastIndexedAt: number | null;
}
