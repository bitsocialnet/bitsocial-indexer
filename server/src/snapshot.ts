/**
 * Snapshot export: a downloadable copy of everything this instance serves.
 *
 *   node dist/snapshot.js <output-dir>        (npm run snapshot -- <output-dir> in development)
 *
 * The snapshot holds exactly what the API serves, redacted the same way (see
 * servedComments in db/): no mod-queue comments, and removed, deleted and
 * taken-down comments only as tombstones with their content nulled. Content
 * taken down after a snapshot is published stays in that copy, so publish
 * snapshots where you can replace them, and regenerate after each takedown.
 *
 * The export only reads the database. In particular it never applies the
 * blocklist to it: with BLOCKLIST_SOURCE unset, setBlocklist([]) would lift
 * every stored takedown, and the running server only re-applies the file when
 * its mtime changes, so it would go on serving them. Instead, a configured
 * BLOCKLIST_SOURCE is read and applied to the exported rows on top of the
 * stored flags, and a configured file that cannot be read aborts the export.
 *
 * Output, written to a temporary sibling directory and renamed into place on
 * success, so a failed run never leaves a partial snapshot at <output-dir>:
 *
 *   communities.jsonl.gz  one community per line, as GET /api/communities
 *   comments.jsonl.gz     one comment per line, as GET /api/posts/:cid, grouped by thread
 *   manifest.json         format version, creation time, record counts, SHA-256 per file
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';
import { loadBlocklist } from './blocklist.js';
import { config } from './config.js';
import { getDb, listCommunities, servedComments, type BlocklistEntry } from './db/index.js';

export const SNAPSHOT_FORMAT = 'bitsocial-indexer-snapshot';
export const SNAPSHOT_VERSION = 1;

export interface SnapshotFile {
  records: number;
  bytes: number;
  sha256: string;
}

export interface SnapshotManifest {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  /** Unix seconds. */
  created_at: number;
  site_name: string;
  site_url: string;
  /** True when BLOCKLIST_SOURCE was read for this run, not just the stored takedown flags. */
  blocklist_file_applied: boolean;
  files: Record<'communities.jsonl.gz' | 'comments.jsonl.gz', SnapshotFile>;
}

/** Stream rows to a gzipped JSON Lines file, hashing the compressed bytes on the way. */
async function writeJsonLines(path: string, rows: Iterable<unknown>): Promise<SnapshotFile> {
  let records = 0;
  let bytes = 0;
  const hash = createHash('sha256');
  function* lines(): Generator<string> {
    for (const row of rows) {
      records++;
      yield `${JSON.stringify(row)}\n`;
    }
  }
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(Readable.from(lines()), createGzip(), tap, createWriteStream(path, { flags: 'wx' }));
  return { records, bytes, sha256: hash.digest('hex') };
}

export async function exportSnapshot(
  outDir: string,
  blocklistSource: string = config.blocklistSource,
): Promise<SnapshotManifest> {
  const target = resolve(outDir);
  if (existsSync(target)) throw new Error(`${target} already exists; snapshots never overwrite`);

  let extra: BlocklistEntry[] = [];
  if (blocklistSource) {
    try {
      extra = await loadBlocklist(blocklistSource);
    } catch (err) {
      throw new Error(`BLOCKLIST_SOURCE is set but could not be read, so no snapshot was written: ${String(err)}`);
    }
  }

  const tmp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}`);
  await mkdir(tmp, { recursive: true });
  try {
    const db = getDb();
    // One read transaction, so communities and comments come from the same
    // moment while the crawler keeps writing. Nothing is written: rolled back.
    db.exec('BEGIN');
    let communities: SnapshotFile;
    let comments: SnapshotFile;
    try {
      communities = await writeJsonLines(join(tmp, 'communities.jsonl.gz'), listCommunities());
      comments = await writeJsonLines(join(tmp, 'comments.jsonl.gz'), servedComments(extra));
    } finally {
      db.exec('ROLLBACK');
    }
    const manifest: SnapshotManifest = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      created_at: Math.floor(Date.now() / 1000),
      site_name: config.siteName,
      site_url: config.siteUrl,
      blocklist_file_applied: Boolean(blocklistSource),
      files: { 'communities.jsonl.gz': communities, 'comments.jsonl.gz': comments },
    };
    await writeFile(join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(tmp, target);
    return manifest;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node dist/snapshot.js <output-dir>');
    process.exit(2);
  }
  const manifest = await exportSnapshot(out);
  const { 'communities.jsonl.gz': communities, 'comments.jsonl.gz': comments } = manifest.files;
  console.log(
    `[snapshot] wrote ${communities.records} communities and ${comments.records} comments to ${resolve(out)}`,
  );
  if (!manifest.blocklist_file_applied) {
    console.warn('[snapshot] BLOCKLIST_SOURCE is not set: only takedowns already stored in the database were applied');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('[snapshot]', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
