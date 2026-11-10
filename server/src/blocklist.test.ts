import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
const { loadBlocklist, parseBlocklist, pollBlocklist, startBlocklist, stopBlocklist } = await import('./blocklist.js');
const { getThread, insertComments, searchPosts, setBlocklist } = await import('./db/index.js');
const { config } = await import('./config.js');

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

/** Run startBlocklist against `source`, as if BLOCKLIST_SOURCE named it. */
async function startWith(source: string): Promise<void> {
  const configured = config.blocklistSource;
  Object.defineProperty(config, 'blocklistSource', { value: source });
  try {
    await startBlocklist();
  } finally {
    stopBlocklist();
    Object.defineProperty(config, 'blocklistSource', { value: configured });
  }
}

test('startup refuses a blocklist file that exists but cannot be loaded', async () => {
  // Takedowns from an earlier run persist in the database, but ingest checks
  // new comments against the in-memory list, so starting without the list
  // would serve new replies to a taken-down thread.
  writeFileSync(file, 'not json{');
  utimesSync(file, ++fakeTime, fakeTime);
  await assert.rejects(startWith(file), /BLOCKLIST_SOURCE/);

  // A file that loads, or no file at all (an empty list), starts as before.
  writeList([]);
  await startWith(file);
  await startWith(join(dir, 'absent.json'));
});

test(
  'a blocklist file that cannot be reached is not read as deleted',
  { skip: process.getuid?.() === 0 && 'root ignores directory permissions' },
  async () => {
    insertComments([
      { cid: 'locked-op', community_address: 'locked.bso', post_cid: 'locked-op', depth: 0, timestamp: 1, content: 'locked marmot' },
    ]);
    const lockedDir = join(dir, 'locked');
    mkdirSync(lockedDir);
    const lockedFile = join(lockedDir, 'blocklist.json');
    writeFileSync(lockedFile, JSON.stringify(['locked-op']));
    assert.equal(await pollBlocklist(lockedFile), true);
    assert.equal(getThread('locked-op')?.post.takedown, 1);

    // The file is still there, but stat() now fails with EACCES, not ENOENT.
    chmodSync(lockedDir, 0o000);
    try {
      assert.equal(await pollBlocklist(lockedFile), false, 'a poll keeps the last list');
      assert.equal(getThread('locked-op')?.post.takedown, 1);
      await assert.rejects(startWith(lockedFile), /BLOCKLIST_SOURCE/);
      assert.equal(getThread('locked-op')?.post.takedown, 1, 'startup lifts no takedown');
      assert.equal(searchPosts({ q: 'marmot' }).total, 0);
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  },
);

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
