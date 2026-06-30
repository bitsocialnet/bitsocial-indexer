/**
 * The crawl loop. Resolves the configured community list, schedules each one,
 * and indexes due communities through the PKC client.
 *
 * Empty by default: if the operator has configured nothing, this stays idle and
 * the indexer serves an empty index — the dev decides what to index.
 */
import { config, hasConfiguredCommunities } from '../config.js';
import { insertComments, upsertCommunity, type CommentInput } from '../db/index.js';
import { getPkcClient } from '../pkc/client.js';
import { due, enqueue, markFailed, markRunning, markSuccess } from './queue.js';

const nowSec = () => Math.floor(Date.now() / 1000);

/** Merge inline COMMUNITIES with an optional external COMMUNITIES_SOURCE list. */
export async function resolveCommunities(): Promise<string[]> {
  const set = new Set(config.communities);
  if (config.communitiesSource) {
    try {
      const list = await loadSource(config.communitiesSource);
      for (const item of list) {
        if (typeof item === 'string') set.add(item);
        else if (item && typeof item === 'object' && 'address' in item) set.add(String((item as { address: unknown }).address));
      }
    } catch (err) {
      console.error(`[crawler] failed to load COMMUNITIES_SOURCE (${config.communitiesSource}):`, err);
    }
  }
  return [...set];
}

/** A community source is either an http(s) URL or a local file path. */
async function loadSource(source: string): Promise<unknown[]> {
  let data: unknown;
  if (/^https?:\/\//.test(source)) {
    data = await (await fetch(source)).json();
  } else {
    const { readFile } = await import('node:fs/promises');
    data = JSON.parse(await readFile(source, 'utf8'));
  }
  // Accept ["a.bso", …] or { communities: [...] }.
  return Array.isArray(data) ? data : ((data as { communities?: unknown[] }).communities ?? []);
}

// ── mapping: pkc-js comment → CommentInput ───────────────────────────────────

function safeJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapComment(c: any, communityAddress: string): CommentInput | null {
  if (!c?.cid) return null;
  return {
    cid: c.cid,
    community_address: c.communityAddress ?? communityAddress,
    post_cid: c.postCid ?? c.cid,
    parent_cid: c.parentCid ?? null,
    depth: typeof c.depth === 'number' ? c.depth : c.parentCid ? 1 : 0,
    timestamp: typeof c.timestamp === 'number' ? c.timestamp : nowSec(),
    author_address: c.author?.address ?? null,
    author_name: c.author?.displayName ?? null,
    title: c.title ?? null,
    content: c.content ?? null,
    link: c.link ?? null,
    thumbnail_url: c.thumbnailUrl ?? null,
    upvote_count: c.upvoteCount ?? 0,
    downvote_count: c.downvoteCount ?? 0,
    reply_count: c.replyCount ?? 0,
    raw: safeJson(c.raw ?? null),
  };
}

/**
 * Walk a pkc-js Pages object (community `.posts` or a comment's `.replies`):
 * take the preloaded page, then follow `nextCid` via `getPage`, bounded by
 * `maxPages`. Dedupes against `seen`.
 */
async function collectFromPages(pagesObj: any, maxPages: number, seen: Set<string>): Promise<any[]> {
  if (!pagesObj) return [];
  const sorts = Object.keys(pagesObj.pages ?? {});
  const sort = sorts.includes('new') ? 'new' : sorts[0];
  let page = sort ? pagesObj.pages?.[sort] : undefined;
  if (!page) {
    const cid = pagesObj.pageCids?.new ?? Object.values(pagesObj.pageCids ?? {})[0];
    if (cid && typeof pagesObj.getPage === 'function') page = await pagesObj.getPage({ cid });
  }

  const result: any[] = [];
  let pages = 0;
  while (page && pages < maxPages) {
    for (const c of page.comments ?? []) {
      if (c?.cid && !seen.has(c.cid)) {
        seen.add(c.cid);
        result.push(c);
      }
    }
    pages++;
    const next = page.nextCid;
    if (!next || typeof pagesObj.getPage !== 'function') break;
    page = await pagesObj.getPage({ cid: next });
  }
  return result;
}

/** Map a post and recurse into its reply tree, bounded by reply depth. */
async function collectThread(comment: any, address: string, out: CommentInput[], seen: Set<string>, depth: number): Promise<void> {
  const mapped = mapComment(comment, address);
  if (mapped) out.push(mapped);
  if (depth >= config.crawlMaxReplyDepth) return;
  const replies = await collectFromPages(comment?.replies, config.crawlMaxPages, seen);
  for (const reply of replies) await collectThread(reply, address, out, seen, depth + 1);
}

/** Fetch a community's posts (+ reply threads) via PKC and upsert them. */
async function indexCommunity(address: string): Promise<number> {
  const pkc = await getPkcClient();
  const community: any = await pkc.getCommunity(address);

  const out: CommentInput[] = [];
  const seen = new Set<string>();
  const posts = await collectFromPages(community?.posts, config.crawlMaxPages, seen);
  for (const post of posts) await collectThread(post, address, out, seen, 0);

  const inserted = insertComments(out);
  upsertCommunity({
    address,
    title: community?.title ?? null,
    description: community?.description ?? null,
    last_indexed_at: nowSec(),
  });
  return inserted;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function tick(): Promise<void> {
  for (const row of due()) {
    const { community_address: address } = row;
    markRunning(address);
    try {
      const n = await indexCommunity(address);
      markSuccess(address, nowSec() + Math.floor(config.crawlIntervalMs / 1000));
      if (n) console.log(`[crawler] ${address}: indexed ${n} new comments`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[crawler] ${address}: ${message}`);
      markFailed(address, message, nowSec() + Math.floor(config.crawlIntervalMs / 1000));
    }
  }
}

let timer: NodeJS.Timeout | undefined;

export async function startCrawler(): Promise<void> {
  if (!hasConfiguredCommunities()) {
    console.log('[crawler] idle — no communities configured (COMMUNITIES / COMMUNITIES_SOURCE empty).');
    return;
  }
  const addresses = await resolveCommunities();
  console.log(`[crawler] scheduling ${addresses.length} communities`);
  for (const address of addresses) {
    upsertCommunity({ address, added_at: nowSec() });
    enqueue(address);
  }
  await tick();
  timer = setInterval(() => void tick(), config.crawlIntervalMs);
}

export function stopCrawler(): void {
  if (timer) clearInterval(timer);
}
