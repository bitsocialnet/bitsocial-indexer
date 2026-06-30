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
      const res = await fetch(config.communitiesSource);
      const data: unknown = await res.json();
      // Accept ["a.bso", ...] or { communities: ["a.bso", ...] }.
      const list = Array.isArray(data) ? data : (data as { communities?: unknown[] }).communities ?? [];
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

/**
 * Index one community. Fetches its current comments via PKC and upserts them.
 *
 * TODO(integration): map the pkc-js comment/community object shape to
 * CommentInput. Left unimplemented until wired against a live bitsocial-cli
 * daemon — the neutral demo never reaches this path.
 */
async function indexCommunity(address: string): Promise<number> {
  const pkc = await getPkcClient();
  const community = await pkc.getCommunity(address);
  void community; // shape TBD against @pkcprotocol/pkc-js

  const comments: CommentInput[] = [];
  // for (const raw of walk(community)) comments.push(mapComment(raw));

  const inserted = insertComments(comments);
  upsertCommunity({ address, last_indexed_at: nowSec() });
  return inserted;
}

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
