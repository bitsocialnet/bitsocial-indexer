/**
 * Operator NSFW overrides (NSFW_OVERRIDES_SOURCE): a JSON file that decides,
 * for named communities, whether this instance treats them as NSFW.
 *
 * It is the highest-precedence of the three signals (see resolveNsfw in db/)
 * because the other two can be wrong: a directory list may not say anything,
 * and inference from a single flagged comment can mislabel an otherwise
 * safe-for-work community. So an override states NSFW *and* not-NSFW.
 *
 * File format — an array where each entry is a bare address or an object:
 *
 *   ["adult.bso", { "address": "art.bso", "nsfw": false, "reason": "one bad post" }]
 *
 * `nsfw` defaults to true (marking a community NSFW is the common case). The
 * file is applied at startup and re-applied whenever its mtime changes (polled
 * every 30s) — no restart needed. Removing an entry (or the whole file) hands
 * the community back to the directory-list and inference signals.
 */
import { readFile, stat } from 'node:fs/promises';
import { config } from './config.js';
import { setNsfwOverrides, type NsfwOverride } from './db/index.js';

const POLL_MS = 30_000;

/** Normalize parsed JSON into override entries; invalid items are skipped. */
export function parseNsfwOverrides(data: unknown): NsfwOverride[] {
  if (!Array.isArray(data)) throw new Error('nsfw overrides must be a JSON array');
  const entries: NsfwOverride[] = [];
  for (const item of data) {
    if (typeof item === 'string' && item.trim()) {
      entries.push({ address: item.trim(), nsfw: true, reason: null });
    } else if (item && typeof item === 'object' && typeof (item as { address?: unknown }).address === 'string') {
      const o = item as { address: string; nsfw?: unknown; reason?: unknown };
      if (!o.address.trim()) {
        console.error('[nsfw] skipping invalid entry:', JSON.stringify(item));
        continue;
      }
      entries.push({
        address: o.address.trim(),
        // Only an explicit `false` clears the flag; anything else marks NSFW.
        nsfw: o.nsfw !== false,
        reason: typeof o.reason === 'string' ? o.reason : null,
      });
    } else {
      console.error('[nsfw] skipping invalid entry:', JSON.stringify(item));
    }
  }
  return entries;
}

export async function loadNsfwOverrides(path: string): Promise<NsfwOverride[]> {
  return parseNsfwOverrides(JSON.parse(await readFile(path, 'utf8')));
}

let lastMtimeMs: number | null = null; // null = never checked, -1 = file absent
let timer: NodeJS.Timeout | undefined;

/** Check the file's mtime and (re)apply it when it changed. Exported for tests. */
export async function pollNsfwOverrides(source = config.nsfwOverridesSource): Promise<void> {
  if (!source) return;
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(source)).mtimeMs;
  } catch {
    // Missing file = no overrides (deleting the file drops back to the lists).
    if (lastMtimeMs !== -1) {
      if (lastMtimeMs !== null) console.log(`[nsfw] ${source} is gone — overrides cleared`);
      lastMtimeMs = -1;
      setNsfwOverrides([]);
    }
    return;
  }
  if (mtimeMs === lastMtimeMs) return;
  try {
    const entries = await loadNsfwOverrides(source);
    lastMtimeMs = mtimeMs;
    setNsfwOverrides(entries);
    console.log(`[nsfw] applied ${entries.length} overrides from ${source}`);
  } catch (err) {
    // A broken file keeps the previous overrides; retried on the next poll.
    console.error(`[nsfw] failed to load ${source}:`, err);
  }
}

/** Apply the overrides now and keep watching the file for changes. */
export async function startNsfwOverrides(): Promise<void> {
  if (!config.nsfwOverridesSource) {
    setNsfwOverrides([]); // clear overrides left over from a previous configuration
    return;
  }
  await pollNsfwOverrides();
  timer = setInterval(() => void pollNsfwOverrides(), POLL_MS);
  timer.unref();
}

export function stopNsfwOverrides(): void {
  if (timer) clearInterval(timer);
}
