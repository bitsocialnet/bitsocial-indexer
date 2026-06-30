import type { Community, Health, PostPage, SearchResult, Thread } from './types';

const BASE = process.env.INDEXER_API ?? 'http://localhost:4000';

/** Fetch JSON from the indexer API; returns null on any failure (API down, 404…). */
async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const apiBase = BASE;

export const getHealth = () => get<Health>('/api/health');
export const getCommunities = () => get<{ communities: Community[] }>('/api/communities');
export const getCommunity = (address: string) => get<Community>(`/api/communities/${encodeURIComponent(address)}`);
export const getPosts = (query = '') => get<PostPage>(`/api/posts${query}`);
export const getThread = (cid: string) => get<Thread>(`/api/posts/${encodeURIComponent(cid)}`);
export const search = (q: string) => get<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`);
