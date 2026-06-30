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
