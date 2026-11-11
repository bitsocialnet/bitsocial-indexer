/**
 * Operator takedown blocklist (BLOCKLIST_SOURCE): a JSON file of CIDs this
 * instance must stop serving. An archive keeps serving content after it is
 * gone from the source network, so upstream moderation can no longer reach
 * it — takedown requests (DMCA, illegal content) need an operator-side
 * mechanism instead.
 *
 * File format — an array where each entry is a bare CID string or an object:
 *
 *   ["QmSomeComment…", { "cid": "QmSomeThread…", "scope": "thread", "reason": "DMCA #123" }]
 *
 * `scope` defaults to "comment"; "thread" redacts the post AND all its
 * replies. The file is applied at startup and re-applied whenever its mtime
 * changes (polled every 30s) — no restart needed. Removing an entry (or the
 * whole file) restores the stored content: the redaction is reversible by
 * design, content columns are never destroyed (see setBlocklist in db/).
 */
import { readFile, stat } from 'node:fs/promises';
import { config } from './config.js';
import { setBlocklist, type BlocklistEntry } from './db/index.js';

const POLL_MS = 30_000;

/** Normalize parsed JSON into blocklist entries; invalid items are skipped. */
export function parseBlocklist(data: unknown): BlocklistEntry[] {
  if (!Array.isArray(data)) throw new Error('blocklist must be a JSON array');
  const entries: BlocklistEntry[] = [];
  for (const item of data) {
    if (typeof item === 'string' && item.trim()) {
      entries.push({ cid: item.trim(), scope: 'comment', reason: null });
    } else if (item && typeof item === 'object' && typeof (item as { cid?: unknown }).cid === 'string') {
      const o = item as { cid: string; scope?: unknown; reason?: unknown };
      entries.push({
        cid: o.cid.trim(),
        scope: o.scope === 'thread' ? 'thread' : 'comment',
        reason: typeof o.reason === 'string' ? o.reason : null,
      });
    } else {
      console.error('[blocklist] skipping invalid entry:', JSON.stringify(item));
    }
  }
  return entries;
}

export async function loadBlocklist(path: string): Promise<BlocklistEntry[]> {
  return parseBlocklist(JSON.parse(await readFile(path, 'utf8')));
}

let lastMtimeMs: number | null = null; // null = never checked, -1 = file absent
let timer: NodeJS.Timeout | undefined;

/**
 * Check the file's mtime and (re)apply it when it changed. Resolves false when
 * the file could not be loaded for any reason other than being absent.
 * Exported for tests.
 */
export async function pollBlocklist(source = config.blocklistSource): Promise<boolean> {
  if (!source) return true;
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(source)).mtimeMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      // The file may still be there (a permission or I/O error on its path):
      // keep the previous blocklist, as for a file that will not parse.
      console.error(`[blocklist] cannot check ${source}:`, err);
      return false;
    }
    // Missing file = empty blocklist (deleting the file restores everything).
    if (lastMtimeMs !== -1) {
      if (lastMtimeMs !== null) console.log(`[blocklist] ${source} is gone — blocklist cleared`);
      lastMtimeMs = -1;
      setBlocklist([]);
    }
    return true;
  }
  if (mtimeMs === lastMtimeMs) return true;
  try {
    const entries = await loadBlocklist(source);
    lastMtimeMs = mtimeMs;
    setBlocklist(entries);
    console.log(`[blocklist] applied ${entries.length} entries from ${source}`);
    return true;
  } catch (err) {
    // A broken file keeps the previous blocklist; retried on the next poll.
    console.error(`[blocklist] failed to load ${source}:`, err);
    return false;
  }
}

/** Apply the blocklist now and keep watching the file for changes. */
export async function startBlocklist(): Promise<void> {
  if (!config.blocklistSource) {
    setBlocklist([]); // clear takedowns left over from a previous configuration
    return;
  }
  // Fail closed. At startup there is no previous list to keep: takedowns from
  // the last run persist in the database, but ingest checks new comments
  // against the in-memory list, so serving without it would publish new
  // replies to a taken-down thread and blocklisted CIDs not yet indexed.
  if (!(await pollBlocklist())) {
    throw new Error(
      `BLOCKLIST_SOURCE ${config.blocklistSource} exists but could not be loaded; not starting without it`,
    );
  }
  timer = setInterval(() => void pollBlocklist(), POLL_MS);
  timer.unref();
}

export function stopBlocklist(): void {
  if (timer) clearInterval(timer);
}
