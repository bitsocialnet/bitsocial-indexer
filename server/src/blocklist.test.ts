import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
const { loadBlocklist, parseBlocklist, pollBlocklist } = await import('./blocklist.js');
const { getThread, insertComments, searchPosts, setBlocklist } = await import('./db/index.js');

const dir = mkdtempSync(join(tmpdir(), 'indexer-blocklist-'));
const file = join(dir, 'blocklist.json');
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** Write the file with a strictly increasing mtime so the poller sees a change. */
let fakeTime = Math.floor(Date.now() / 1000);
function writeList(entries: unknown): void {
  writeFileSync(file, JSON.stringify(entries));
  utimesSync(file, ++fakeTime, fakeTime);
}

test('parseBlocklist accepts bare CIDs and objects, defaulting scope to comment', () => {
  const entries = parseBlocklist([
    'QmBare',
    { cid: 'QmObj' },
    { cid: 'QmThread', scope: 'thread', reason: 'DMCA #1' },
  ]);
  assert.deepEqual(entries, [
    { cid: 'QmBare', scope: 'comment', reason: null },
    { cid: 'QmObj', scope: 'comment', reason: null },
    { cid: 'QmThread', scope: 'thread', reason: 'DMCA #1' },
  ]);
});

test('parseBlocklist skips invalid entries and rejects non-arrays', () => {
  assert.deepEqual(parseBlocklist([42, {}, '', { scope: 'thread' }]), []);
  assert.throws(() => parseBlocklist({ cids: [] }));
});

test('loadBlocklist reads and normalizes a JSON file', async () => {
  writeList(['QmFromFile', { cid: 'QmT', scope: 'thread' }]);
  assert.deepEqual(await loadBlocklist(file), [
    { cid: 'QmFromFile', scope: 'comment', reason: null },
    { cid: 'QmT', scope: 'thread', reason: null },
  ]);
});

test('pollBlocklist applies the file, picks up changes, and clears on deletion', async () => {
  insertComments([
    {
      cid: 'poll-op',
      community_address: 'poll.bso',
      post_cid: 'poll-op',
      depth: 0,
      timestamp: 1,
      title: 'poll title',
      content: 'polling ferret',
    },
  ]);
  assert.equal(searchPosts({ q: 'ferret' }).total, 1);

  // 1. File appears with an entry → redacted.
  writeList([{ cid: 'poll-op', reason: 'takedown request' }]);
  await pollBlocklist(file);
  assert.equal(getThread('poll-op')?.post.takedown, 1);
  assert.equal(getThread('poll-op')?.post.takedown_reason, 'takedown request');
  assert.equal(getThread('poll-op')?.post.content, null);
  assert.equal(searchPosts({ q: 'ferret' }).total, 0);

  // 2. Unchanged mtime → the poller does not reapply.
  setBlocklist([]);
  await pollBlocklist(file);
  assert.equal(getThread('poll-op')?.post.takedown, 0, 'no reload while mtime is unchanged');

  // 3. mtime bump with the entry still present → redacted again.
  writeList(['poll-op']);
  await pollBlocklist(file);
  assert.equal(getThread('poll-op')?.post.takedown, 1);

  // 4. A broken file keeps the previous blocklist.
  writeFileSync(file, 'not json{');
  utimesSync(file, ++fakeTime, fakeTime);
  await pollBlocklist(file);
  assert.equal(getThread('poll-op')?.post.takedown, 1, 'broken file keeps last good list');

  // 5. Entry removed → restored, including search.
  writeList([]);
  await pollBlocklist(file);
  assert.equal(getThread('poll-op')?.post.takedown, 0);
  assert.equal(getThread('poll-op')?.post.content, 'polling ferret');
  assert.equal(searchPosts({ q: 'ferret' }).total, 1);

  // 6. File deleted entirely → blocklist cleared (nothing left redacted).
  writeList(['poll-op']);
  await pollBlocklist(file);
  assert.equal(getThread('poll-op')?.post.takedown, 1);
  rmSync(file);
  await pollBlocklist(file);
  assert.equal(getThread('poll-op')?.post.takedown, 0);
  assert.equal(searchPosts({ q: 'ferret' }).total, 1);
});
