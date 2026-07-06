import type { Community, Health, PostPage, SearchResult, Thread } from './types';

const BASE = process.env.INDEXER_API ?? 'http://localhost:4000';

/**
 * Fetch JSON from the indexer API; returns null on any failure (API down, 404…).
 * `revalidate` (seconds) opts the request into Next's data cache so SSR pages
 * don't hit the API on every request; omit it for uncached (no-store) fetches.
 */
async function get<T>(path: string, revalidate?: number): Promise<T | null> {
  try {
    const res = await fetch(
      `${BASE}${path}`,
      revalidate === undefined ? { cache: 'no-store' } : { next: { revalidate } },
    );
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const apiBase = BASE;

export const getHealth = () => get<Health>('/api/health', 60);
export const getCommunities = (revalidate = 300) => get<{ communities: Community[] }>('/api/communities', revalidate);
export const getCommunity = (address: string) =>
  get<Community>(`/api/communities/${encodeURIComponent(address)}`, 300);
export const getPosts = (query = '', revalidate = 60) => get<PostPage>(`/api/posts${query}`, revalidate);
export const getThread = (cid: string) => get<Thread>(`/api/posts/${encodeURIComponent(cid)}`, 300);
export const search = (q: string) => get<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`);
