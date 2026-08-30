/**
 * The crawl loop. Resolves the configured community list, schedules each one,
 * and indexes due communities through the PKC client.
 *
 * Empty by default: if the operator has configured nothing, this stays idle and
 * the indexer serves an empty index — the dev decides what to index.
 */
import { config, hasConfiguredCommunities } from '../config.js';
import { applyNsfwSignals, insertComments, setNsfwList, upsertCommunity, type CommentInput } from '../db/index.js';
import { getPkcClient, resetPkcClient } from '../pkc/client.js';
import { due, enqueue, markFailed, markRunning, markSuccess, reclaimAbandoned } from './queue.js';

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Reject if `promise` has not settled within `ms`. The PKC calls a crawl pass
 * makes have no bound of their own; one that never settles would otherwise hold
 * its queue lease and block every community behind it in the pass.
 */
export class CrawlTimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CrawlTimeoutError(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Run every item with a fixed worker pool, preserving a hard concurrency cap. */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  let next = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await worker(item);
      }
    }),
  );
}

export interface ConfiguredCommunity {
  address: string;
  /**
   * The list's own NSFW verdict, when it states one. Bitsocial directory lists
   * carry an optional `nsfw` boolean per entry (the same field seedit's client
   * normalises); absent means the list has no opinion and the indexer falls
   * back to inferring from content.
   */
  nsfw?: boolean;
}

/**
 * Merge inline COMMUNITIES with an optional external COMMUNITIES_SOURCE list.
 * Inline entries are addresses only, so a duplicate keeps the list entry's
 * metadata — an operator naming a community in both places still gets the
 * list's `nsfw` flag.
 */
export async function resolveCommunities(): Promise<ConfiguredCommunity[]> {
  const found = new Map<string, ConfiguredCommunity>();
  for (const address of config.communities) found.set(address, { address });
  if (config.communitiesSource) {
    try {
      const list = await loadSource(config.communitiesSource);
      for (const item of list) {
        const entry = parseCommunityEntry(item);
        if (entry) found.set(entry.address, entry);
      }
    } catch (err) {
      console.error(`[crawler] failed to load COMMUNITIES_SOURCE (${config.communitiesSource}):`, err);
    }
  }
  return [...found.values()];
}

/** One entry of a community list: a bare address, or an object carrying flags. */
export function parseCommunityEntry(item: unknown): ConfiguredCommunity | null {
  if (typeof item === 'string') return item.trim() ? { address: item.trim() } : null;
  if (!item || typeof item !== 'object' || !('address' in item)) return null;
  const o = item as { address: unknown; nsfw?: unknown };
  const address = String(o.address).trim();
  if (!address) return null;
  // Only a real boolean counts as a verdict, matching how the seedit client
  // normalises these lists: anything else leaves the signal unset.
  return typeof o.nsfw === 'boolean' ? { address, nsfw: o.nsfw } : { address };
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
/**
 * Map a pkc-js page comment to a row. Moderation flags may live flattened on
 * the comment itself and/or on its CommentUpdate (`raw.commentUpdate`); an
 * author delete additionally hides under the update's `edit`. Exported for tests.
 */
export function mapComment(c: any, communityAddress: string, seenAt = nowSec()): CommentInput | null {
  if (!c?.cid) return null;
  const update = c.raw?.commentUpdate ?? {};
  return {
    cid: c.cid,
    // Group by the address the operator configured, not a legacy address
    // embedded in the signed publication. A canonical `.bso` directory may
    // resolve publications originally signed for its old `.eth` alias.
    community_address: communityAddress,
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
    first_seen_at: seenAt,
    last_seen_at: seenAt,
    pending_approval: Boolean(c.pendingApproval ?? update.pendingApproval),
    removed: Boolean(c.removed ?? update.removed),
    deleted: Boolean(c.deleted ?? c.edit?.deleted ?? update.edit?.deleted),
    mod_reason: c.reason ?? update.reason ?? c.edit?.reason ?? update.edit?.reason ?? null,
    upstream_archived: Boolean(c.archived ?? update.archived),
    // pkc-js resolves nsfw as commentUpdate.nsfw → commentUpdate.edit.nsfw →
    // comment.nsfw and flattens the winner onto the page comment, so the flat
    // value is authoritative when present; the rest covers other shapes.
    nsfw: Boolean(c.nsfw ?? update.nsfw ?? update.edit?.nsfw ?? c.edit?.nsfw),
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
async function collectThread(comment: any, address: string, out: CommentInput[], seen: Set<string>, depth: number, seenAt: number): Promise<void> {
  const mapped = mapComment(comment, address, seenAt);
  if (mapped) out.push(mapped);
  if (depth >= config.crawlMaxReplyDepth) return;
  const replies = await collectFromPages(comment?.replies, config.crawlMaxPages, seen);
  for (const reply of replies) await collectThread(reply, address, out, seen, depth + 1, seenAt);
}

/**
 * Fetch a community's posts (+ reply threads) via PKC and upsert them.
 *
 * Everything collected in one pass is stamped with the same `crawledAt`, which
 * also becomes the community's `last_indexed_at`. A comment whose last_seen_at
 * is older than the community's last_indexed_at therefore fell out of the live
 * pages (archived/purged upstream) — it stays in the index and is served with
 * `archived: 1`.
 */
async function indexCommunity(address: string): Promise<number> {
  const pkc = await getPkcClient();
  const community: any = await pkc.getCommunity(address);
  const crawledAt = nowSec();

  const out: CommentInput[] = [];
  const seen = new Set<string>();
  const posts = await collectFromPages(community?.posts, config.crawlMaxPages, seen);
  for (const post of posts) await collectThread(post, address, out, seen, 0, crawledAt);

  const inserted = insertComments(out);
  upsertCommunity({
    address,
    title: community?.title ?? null,
    description: community?.description ?? null,
    last_indexed_at: crawledAt,
  });
  // Newly indexed comments can change the inferred signal, so re-resolve the
  // NSFW verdict for every community this pass could have affected.
  applyNsfwSignals();
  return inserted;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let ticking = false;

async function tick(): Promise<void> {
  // A pass slower than the interval must not run alongside the next one: the
  // two would compete for the same due rows.
  if (ticking) return;
  ticking = true;
  try {
    await runWithConcurrency(due(), config.crawlConcurrency, async (row) => {
      const { community_address: address } = row;
      markRunning(address);
      try {
        const n = await withTimeout(indexCommunity(address), config.crawlTimeoutMs, `${address} crawl`);
        markSuccess(address, nowSec() + Math.floor(config.crawlIntervalMs / 1000));
        if (n) console.log(`[crawler] ${address}: indexed ${n} new comments`);
      } catch (err) {
        if (err instanceof CrawlTimeoutError) {
          // A hung RPC promise cannot be cancelled directly. Retiring its
          // transport rejects the orphan and gives subsequent work a new one.
          void resetPkcClient();
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[crawler] ${address}: ${message}`);
        markFailed(address, message, nowSec() + Math.floor(config.crawlIntervalMs / 1000));
      }
    });
  } finally {
    ticking = false;
  }
}

let timer: NodeJS.Timeout | undefined;

export async function startCrawler(): Promise<void> {
  if (!hasConfiguredCommunities()) {
    console.log('[crawler] idle — no communities configured (COMMUNITIES / COMMUNITIES_SOURCE empty).');
    return;
  }
  const communities = await resolveCommunities();
  console.log(`[crawler] scheduling ${communities.length} communities`);
  for (const { address } of communities) {
    upsertCommunity({ address, added_at: nowSec() });
    enqueue(address);
  }
  // The list's own NSFW flags outrank inference, so apply them before the first
  // pass rather than after it.
  setNsfwList(communities);
  const reclaimed = reclaimAbandoned();
  if (reclaimed) console.log(`[crawler] reclaimed ${reclaimed} crawl leases abandoned by a previous run`);
  console.log(
    `[crawler] refresh target ${config.crawlIntervalMs}ms, concurrency ${config.crawlConcurrency}, timeout ${config.crawlTimeoutMs}ms`,
  );
  await tick();
  timer = setInterval(() => void tick(), config.crawlIntervalMs);
}

export function stopCrawler(): void {
  if (timer) clearInterval(timer);
}
