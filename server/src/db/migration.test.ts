import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'indexer-migration-'));
process.env.DB_PATH = join(directory, 'legacy.sqlite');

// The preceding schema, with ordinary successful crawl timestamps but no
// evidence that those crawls exhausted the all-time post chain.
const legacy = new Database(process.env.DB_PATH);
legacy.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
  .replace(/^.*last_complete_posts_crawl_at.*\n/m, ''));
legacy.prepare('INSERT INTO communities (address, added_at, last_indexed_at) VALUES (?, ?, ?)').run('legacy.bso', 1, 100);
legacy.prepare(`INSERT INTO comments (cid, community_address, post_cid, depth, timestamp, indexed_at, last_seen_at, upstream_archived)
  VALUES (?, 'legacy.bso', ?, 0, 1, 1, 1, ?)`).run('legacy-active', 'legacy-active', 0);
legacy.prepare(`INSERT INTO comments (cid, community_address, post_cid, depth, timestamp, indexed_at, last_seen_at, upstream_archived)
  VALUES (?, 'legacy.bso', ?, 0, 1, 1, NULL, ?)`).run('legacy-explicit', 'legacy-explicit', 1);
legacy.close();

const { getCommunity, getDb, getThread } = await import('./index.js');
test.after(() => {
  getDb().close();
  rmSync(directory, { recursive: true, force: true });
});

test('legacy database migration adds no invented completeness and preserves rows', () => {
  const community = getCommunity('legacy.bso');
  assert.ok(community);
  assert.equal(community.last_indexed_at, 100);
  assert.equal(community.last_complete_posts_crawl_at, null);
  assert.equal(getThread('legacy-active')?.post.archived, 0);
  const explicit = getThread('legacy-explicit')?.post;
  assert.ok(explicit);
  assert.equal(explicit.archived, 1);
  assert.equal(explicit.last_seen_at, null, 'the archive migration does not backfill unrelated seen times');
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n, 2);
  assert.deepEqual(getDb().pragma('quick_check'), [{ quick_check: 'ok' }]);
});
