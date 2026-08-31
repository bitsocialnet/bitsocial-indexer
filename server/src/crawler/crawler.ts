/**
 * The crawl loop. Resolves the configured community list, schedules each one,
 * and indexes due communities through the PKC client.
 *
 * Empty by default: if the operator has configured nothing, this stays idle and
 * the indexer serves an empty index — the dev decides what to index.
 */
import { config, hasConfiguredCommunities } from '../config.js';
import {
  applyNsfwSignals,
  insertComments,
  setDirectorySafeForWork,
  upsertCommunity,
  type CommentInput,
} from '../db/index.js';
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

/** Merge inline COMMUNITIES with an optional external COMMUNITIES_SOURCE list. */
export async function resolveCommunities(): Promise<string[]> {
  const found = new Set<string>(config.communities);
  if (config.communitiesSource) {
    try {
      for (const item of await loadSource(config.communitiesSource)) {
        const address = parseCommunityEntry(item);
        if (address) found.add(address);
      }
    } catch (err) {
      console.error(`[crawler] failed to load COMMUNITIES_SOURCE (${config.communitiesSource}):`, err);
    }
  }
  return [...found];
}

/** One entry of a community list: a bare address, or an object carrying one. */
export function parseCommunityEntry(item: unknown): string | null {
  if (typeof item === 'string') return item.trim() || null;
  if (!item || typeof item !== 'object' || !('address' in item)) return null;
  return String((item as { address: unknown }).address).trim() || null;
}

/** A JSON source is either an http(s) URL or a local file path. */
async function loadJson(source: string): Promise<unknown> {
  if (/^https?:\/\//.test(source)) return (await fetch(source)).json();
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(source, 'utf8'));
}

/** Address entries of a list file: `["a.bso", …]` or `{ communities|boards: [...] }`. */
async function loadSource(source: string): Promise<unknown[]> {
  const data = await loadJson(source);
  if (Array.isArray(data)) return data;
  const o = data as { communities?: unknown; boards?: unknown } | null;
  for (const entries of [o?.communities, o?.boards]) if (Array.isArray(entries)) return entries;
  return [];
}

// ── directory-level safeForWork ──────────────────────────────────────────────

/**
 * A community declares `features.safeForWork` itself, but many never do — and a
 * Bitsocial client already knows the answer for those from its directory lists.
 * 5chan states it once per *directory*, in `<prefix>-directories-defaults.json`
 * under `directories.<code>.features.safeForWork`; the per-directory files hold
 * only candidate addresses. So the join is: read the defaults, then read each
 * code's address list and hand every address in it that directory's verdict.
 *
 * The sibling file name is the convention the bitsocialnet/lists repo documents
 * — `5chan-directories/5chan-directories-defaults.json` sits next to
 * `5chan-directories/5chan-<code>-directory.json` — so pointing
 * DIRECTORY_DEFAULTS_SOURCE at the defaults file is enough to reach both.
 */
export interface DirectorySafeForWork {
  address: string;
  safeForWork: boolean;
}

const DEFAULTS_SUFFIX = '-directories-defaults.json';

/** One address-list fetch per directory code — 5chan currently has 64 of them. */
const DIRECTORY_CONCURRENCY = 8;

/** Where one directory code's address list sits, given the defaults source. */
export function directoryListSource(defaultsSource: string, code: string): string | null {
  const cut = defaultsSource.lastIndexOf('/') + 1;
  const base = defaultsSource.slice(cut);
  if (!base.endsWith(DEFAULTS_SUFFIX)) return null;
  return `${defaultsSource.slice(0, cut)}${base.slice(0, -DEFAULTS_SUFFIX.length)}-${code}-directory.json`;
}

/** Read `directories.<code>.features.safeForWork` out of a defaults file. */
export function parseDirectoryDefaults(data: unknown): Map<string, boolean> {
  const found = new Map<string, boolean>();
  const directories = (data as { directories?: unknown } | null)?.directories;
  if (!directories || typeof directories !== 'object') return found;
  for (const [code, entry] of Object.entries(directories as Record<string, unknown>)) {
    const safeForWork = (entry as { features?: { safeForWork?: unknown } } | null)?.features?.safeForWork;
    // Only a real boolean is a verdict — exactly how 5chan reads this field.
    // A directory that states nothing leaves its addresses to inference.
    if (typeof safeForWork === 'boolean') found.set(code, safeForWork);
  }
  return found;
}

/** Join DIRECTORY_DEFAULTS_SOURCE's per-code verdicts onto community addresses. */
export async function resolveDirectorySafeForWork(
  source = config.directoryDefaultsSource,
): Promise<DirectorySafeForWork[]> {
  if (!source) return [];
  let defaults: Map<string, boolean>;
  try {
    defaults = parseDirectoryDefaults(await loadJson(source));
  } catch (err) {
    console.error(`[crawler] failed to load DIRECTORY_DEFAULTS_SOURCE (${source}):`, err);
    return [];
  }

  const entries: DirectorySafeForWork[] = [];
  await runWithConcurrency([...defaults], DIRECTORY_CONCURRENCY, async ([code, safeForWork]) => {
    const listSource = directoryListSource(source, code);
    if (!listSource) return;
    try {
      for (const item of await loadSource(listSource)) {
        const address = parseCommunityEntry(item);
        if (address) entries.push({ address, safeForWork });
      }
    } catch (err) {
      // One unreachable directory file must not cost the others their verdict.
      console.error(`[crawler] directory ${code}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return entries;
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
    // The owner's own declaration, and the strongest signal after an operator
    // override. Written only when the community actually resolved, so a failed
    // lookup cannot erase the last one; `null` here is a real observation —
    // this owner has set no `safeForWork` — not a missing value.
    ...(community ? { safe_for_work: readSafeForWork(community) } : {}),
  });
  // Newly indexed comments can change the inferred signal, so re-resolve the
  // NSFW verdict for every community this pass could have affected.
  applyNsfwSignals();
  return inserted;
}

/** `community.features.safeForWork` as the three-state flag the protocol defines. */
export function readSafeForWork(community: any): number | null {
  const safeForWork = community?.features?.safeForWork;
  // Only a real boolean is a declaration: pkc-js types the field
  // `z.boolean().optional()` with no default, so anything else means unset.
  return typeof safeForWork === 'boolean' ? Number(safeForWork) : null;
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
  for (const address of communities) {
    upsertCommunity({ address, added_at: nowSec() });
    enqueue(address);
  }
  // The directory verdicts outrank inference, so apply them before the first
  // pass rather than after it.
  const directory = await resolveDirectorySafeForWork();
  if (directory.length) console.log(`[crawler] ${directory.length} addresses carry a directory safeForWork verdict`);
  setDirectorySafeForWork(directory);
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
