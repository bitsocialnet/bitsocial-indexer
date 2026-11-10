import { showNsfw } from './site';
import type { Community, Health, PostPage, SearchResult, Thread } from './types';

const BASE = process.env.INDEXER_API ?? 'http://localhost:4000';

/**
 * Outcome of an API read. `not_found` is the API's own 404 (that post or
 * community does not exist); `unavailable` is any other failure (API down,
 * 5xx, bad JSON) and says nothing about whether it exists. Callers must keep
 * them apart: a "not found" page or noindex served during an outage tells
 * search engines to drop real archived URLs.
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; reason: 'not_found' | 'unavailable' };

/**
 * Fetch JSON from the indexer API.
 * `revalidate` (seconds) opts the request into Next's data cache so SSR pages
 * don't hit the API on every request; omit it for uncached (no-store) fetches.
 */
async function get<T>(path: string, revalidate?: number): Promise<ApiResult<T>> {
  try {
    const res = await fetch(
      `${BASE}${path}`,
      revalidate === undefined ? { cache: 'no-store' } : { next: { revalidate } },
    );
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export const apiBase = BASE;

export const getHealth = () => get<Health>('/api/health', 60);
export const getCommunities = (revalidate = 300) => get<{ communities: Community[] }>('/api/communities', revalidate);
export const getCommunity = (address: string) =>
  get<Community>(`/api/communities/${encodeURIComponent(address)}`, 300);
export const getPosts = (query = '', revalidate = 60) => get<PostPage>(`/api/posts${query}`, revalidate);
// Uncached: Next serves a data-cache entry once more after its TTL expires (and
// keeps serving it while the refetch fails), so a cached thread would outlive
// a takedown or removal the API already redacts. The API read is one SQLite query.
export const getThread = (cid: string) => get<Thread>(`/api/posts/${encodeURIComponent(cid)}`);
// `nsfw` is always sent: the API excludes NSFW when the parameter is absent, so
// leaving it off would make every instance inherit that default silently. See
// SHOW_NSFW in lib/site.ts.
export const search = (q: string) =>
  get<SearchResult>(`/api/search?q=${encodeURIComponent(q)}&nsfw=${showNsfw}`);
