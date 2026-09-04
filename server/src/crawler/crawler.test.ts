import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
const {
  CrawlTimeoutError,
  directoryListSource,
  mapComment,
  parseCommunityEntry,
  parseDirectoryDefaults,
  readSafeForWork,
  resolveDirectorySafeForWork,
  runWithConcurrency,
  tick,
  withTimeout,
} = await import('./crawler.js');
const { enqueue } = await import('./queue.js');
const { setPkcClientForTest } = await import('../pkc/client.js');
const { getDb } = await import('../db/index.js');

const ADDRESS = 'test.bso';

test('mapComment maps a plain page comment with no moderation flags', () => {
  const row = mapComment({ cid: 'c1', timestamp: 123, title: 't', content: 'b' }, ADDRESS, 999);
  assert.ok(row);
  assert.equal(row.cid, 'c1');
  assert.equal(row.community_address, ADDRESS);
  assert.equal(row.post_cid, 'c1');
  assert.equal(row.first_seen_at, 999);
  assert.equal(row.last_seen_at, 999);
  assert.equal(row.pending_approval, false);
  assert.equal(row.removed, false);
  assert.equal(row.deleted, false);
  assert.equal(row.upstream_archived, false);
});

test('mapComment picks up pendingApproval flattened on the comment', () => {
  const row = mapComment({ cid: 'c2', timestamp: 1, pendingApproval: true }, ADDRESS);
  assert.equal(row?.pending_approval, true);
});

test('mapComment picks up pendingApproval from the raw CommentUpdate', () => {
  const row = mapComment({ cid: 'c3', timestamp: 1, raw: { commentUpdate: { pendingApproval: true } } }, ADDRESS);
  assert.equal(row?.pending_approval, true);
});

test('mapComment picks up removed + reason from the CommentUpdate', () => {
  const row = mapComment({ cid: 'c4', timestamp: 1, raw: { commentUpdate: { removed: true, reason: 'off-topic' } } }, ADDRESS);
  assert.equal(row?.removed, true);
  assert.equal(row?.mod_reason, 'off-topic');
});

test('mapComment picks up an author delete from the CommentUpdate edit', () => {
  const flattened = mapComment({ cid: 'c5', timestamp: 1, deleted: true }, ADDRESS);
  assert.equal(flattened?.deleted, true);
  const nested = mapComment({ cid: 'c6', timestamp: 1, raw: { commentUpdate: { edit: { deleted: true } } } }, ADDRESS);
  assert.equal(nested?.deleted, true);
});

test('mapComment picks up the upstream archived flag', () => {
  const row = mapComment({ cid: 'c7', timestamp: 1, raw: { commentUpdate: { archived: true } } }, ADDRESS);
  assert.equal(row?.upstream_archived, true);
});

test('mapComment returns null without a cid', () => {
  assert.equal(mapComment({}, ADDRESS), null);
});

test('mapComment reads nsfw off the flattened comment and the CommentUpdate', () => {
  assert.equal(mapComment({ cid: 'n1', timestamp: 1 }, ADDRESS)?.nsfw, false);
  assert.equal(mapComment({ cid: 'n2', timestamp: 1, nsfw: true }, ADDRESS)?.nsfw, true);
  assert.equal(mapComment({ cid: 'n3', timestamp: 1, raw: { commentUpdate: { nsfw: true } } }, ADDRESS)?.nsfw, true);
  assert.equal(
    mapComment({ cid: 'n4', timestamp: 1, raw: { commentUpdate: { edit: { nsfw: true } } } }, ADDRESS)?.nsfw,
    true,
  );
});

test('mapComment keeps an explicit nsfw:false from outranking a stale update', () => {
  // pkc-js already resolved commentUpdate → edit → comment onto the flat field,
  // so a flat `false` is a verdict, not a missing value.
  const row = mapComment({ cid: 'n5', timestamp: 1, nsfw: false, raw: { commentUpdate: { nsfw: true } } }, ADDRESS);
  assert.equal(row?.nsfw, false);
});

test('parseCommunityEntry accepts a bare address or an object carrying one', () => {
  assert.equal(parseCommunityEntry(' art.bso '), 'art.bso');
  assert.equal(parseCommunityEntry({ address: 'art.bso', title: 'Art' }), 'art.bso');
  // A directory board entry: extra fields are ignored, the address is all we take.
  assert.equal(parseCommunityEntry({ address: 'flash-posting.bso', publicKey: '12D3Koo', score: 4 }), 'flash-posting.bso');
});

test('parseCommunityEntry rejects unusable entries', () => {
  assert.equal(parseCommunityEntry({ address: '   ' }), null);
  assert.equal(parseCommunityEntry(''), null);
  assert.equal(parseCommunityEntry({ title: 'no address' }), null);
  assert.equal(parseCommunityEntry(null), null);
});

// ── features.safeForWork ─────────────────────────────────────────────────────

test('readSafeForWork keeps the protocol flag three-state', () => {
  assert.equal(readSafeForWork({ features: { safeForWork: true } }), 1);
  assert.equal(readSafeForWork({ features: { safeForWork: false } }), 0);
  assert.equal(readSafeForWork({ features: {} }), null, 'a community with other features but not this one');
  assert.equal(readSafeForWork({}), null, 'no features object at all');
  assert.equal(readSafeForWork(undefined), null);
});

test('readSafeForWork treats a non-boolean value as undeclared, never as true', () => {
  // pkc-js types the field z.boolean().optional() with no default, so anything
  // that is not a boolean is a malformed record, not a declaration.
  assert.equal(readSafeForWork({ features: { safeForWork: 'false' } }), null);
  assert.equal(readSafeForWork({ features: { safeForWork: 0 } }), null);
  assert.equal(readSafeForWork({ features: { safeForWork: null } }), null);
});

// ── directory-level safeForWork ──────────────────────────────────────────────

test('directoryListSource points at the defaults file’s sibling for a code', () => {
  assert.equal(
    directoryListSource(
      'https://raw.githubusercontent.com/bitsocialnet/lists/master/5chan-directories/5chan-directories-defaults.json',
      'f',
    ),
    'https://raw.githubusercontent.com/bitsocialnet/lists/master/5chan-directories/5chan-f-directory.json',
  );
  assert.equal(
    directoryListSource('/config/seedit-directories/seedit-directories-defaults.json', 'memes'),
    '/config/seedit-directories/seedit-memes-directory.json',
  );
  assert.equal(directoryListSource('5chan-directories-defaults.json', 'b'), '5chan-b-directory.json');
});

test('directoryListSource refuses a source that is not a defaults file', () => {
  assert.equal(directoryListSource('/config/communities.json', 'f'), null);
  assert.equal(directoryListSource('', 'f'), null);
});

test('parseDirectoryDefaults reads features.safeForWork per directory code', () => {
  const defaults = parseDirectoryDefaults({
    directories: {
      '3': { directoryCode: '3', features: { safeForWork: true, noSpoilers: true } },
      f: { directoryCode: 'f', features: { safeForWork: false } },
      // Stated as something other than a boolean, or not stated at all: no verdict.
      q: { directoryCode: 'q', features: { safeForWork: 'false' } },
      trash: { directoryCode: 'trash', features: { postsPerPage: 15 } },
      bare: { directoryCode: 'bare' },
    },
  });
  assert.deepEqual([...defaults], [['3', true], ['f', false]]);
});

test('parseDirectoryDefaults survives a file that is not a defaults file', () => {
  for (const data of [null, [], {}, { directories: 'nope' }, { directories: { f: null } }]) {
    assert.equal(parseDirectoryDefaults(data).size, 0);
  }
});

test('resolveDirectorySafeForWork joins the defaults onto every listed address', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'indexer-directories-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data));
  const defaults = join(dir, '5chan-directories-defaults.json');

  write('5chan-directories-defaults.json', {
    directories: {
      f: { directoryCode: 'f', features: { safeForWork: false } },
      '3': { directoryCode: '3', features: { safeForWork: true } },
      // A code whose sibling list is missing must not sink the others.
      gone: { directoryCode: 'gone', features: { safeForWork: false } },
      // A directory that states nothing contributes nothing, list or no list.
      trash: { directoryCode: 'trash', features: {} },
    },
  });
  write('5chan-f-directory.json', { boards: [{ address: 'flash-posting.bso' }, { address: 'flash-two.bso' }] });
  write('5chan-3-directory.json', { boards: [{ address: '3dcg.bso' }] });
  write('5chan-trash-directory.json', { boards: [{ address: 'off-topic.bso' }] });

  const entries = await resolveDirectorySafeForWork(defaults);
  assert.deepEqual(
    entries.sort((a, b) => a.address.localeCompare(b.address)),
    [
      { address: '3dcg.bso', safeForWork: true },
      { address: 'flash-posting.bso', safeForWork: false },
      { address: 'flash-two.bso', safeForWork: false },
    ],
  );
});

test('resolveDirectorySafeForWork also reads the seedit `communities` shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'indexer-directories-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'seedit-directories-defaults.json'),
    JSON.stringify({ directories: { memes: { directoryCode: 'memes', features: { safeForWork: true } } } }),
  );
  writeFileSync(
    join(dir, 'seedit-memes-directory.json'),
    JSON.stringify({ directoryCode: 'memes', communities: [{ address: 'memes.bso', publicKey: '12D3Koo' }] }),
  );

  assert.deepEqual(await resolveDirectorySafeForWork(join(dir, 'seedit-directories-defaults.json')), [
    { address: 'memes.bso', safeForWork: true },
  ]);
});

test('resolveDirectorySafeForWork stays silent when unconfigured or unreadable', async () => {
  assert.deepEqual(await resolveDirectorySafeForWork(''), []);
  assert.deepEqual(await resolveDirectorySafeForWork('/nonexistent/5chan-directories-defaults.json'), []);
});

test('mapComment groups legacy publications under the configured canonical address', () => {
  const row = mapComment({ cid: 'legacy-1', communityAddress: 'test.eth', timestamp: 1 }, ADDRESS);
  assert.equal(row?.community_address, ADDRESS);
});

test('runWithConcurrency processes every item without exceeding its worker cap', async () => {
  let active = 0;
  let peak = 0;
  const completed: number[] = [];

  await runWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (item) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(item);
    active--;
  });

  assert.equal(peak, 3);
  assert.deepEqual(completed.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

test('runWithConcurrency clamps invalid limits to one worker', async () => {
  let active = 0;
  let peak = 0;

  await runWithConcurrency([1, 2], 0, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
  });

  assert.equal(peak, 1);
});

test('withTimeout rejects a hung crawl with a typed timeout error', async () => {
  await assert.rejects(
    withTimeout(new Promise<never>(() => {}), 5, 'test.bso crawl'),
    (err) => err instanceof CrawlTimeoutError && err.message === 'test.bso crawl exceeded 5ms',
  );
});

test('a crawl pass retires the PKC client it used; an idle pass leaves the cache alone', async () => {
  let destroyed = 0;
  setPkcClientForTest(
    Promise.resolve({
      getCommunity: async () => ({
        title: 'Recycle',
        posts: { pages: { new: { comments: [{ cid: 'recycle-p1', timestamp: 1, content: 'hello' }] } } },
      }),
      getComment: async () => ({}),
      destroy: async () => {
        destroyed++;
      },
    }),
  );
  enqueue(ADDRESS);

  await tick();
  assert.equal(destroyed, 1, 'the client that served the pass is destroyed once the pass ends');
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM comments WHERE cid = ?').get('recycle-p1') as { n: number };
  assert.equal(row.n, 1, 'the pass still indexed what it crawled');

  // The community is not due again until the interval elapses, so this pass
  // crawls nothing and must not touch the client cache.
  await tick();
  assert.equal(destroyed, 1);
  setPkcClientForTest(null);
});
