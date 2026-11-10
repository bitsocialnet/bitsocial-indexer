import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// A fresh process with a directory configured, as after a restart: the
// directory verdicts that resolved communities NSFW last run are not in memory
// until the crawler has read the lists again, and the defaults file below does
// not exist yet, so the first read fails.
const dir = mkdtempSync(join(tmpdir(), 'indexer-nsfw-restart-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
process.env.DB_PATH = ':memory:';
process.env.DIRECTORY_DEFAULTS_SOURCE = join(dir, '5chan-directories-defaults.json');
process.env.COMMUNITIES = 'dir-only.bso';
process.env.COMMUNITIES_RELOAD_MS = '20';

const { startCrawler, stopCrawler } = await import('./crawler/crawler.js');
const { setPkcClientForTest } = await import('./pkc/client.js');
const { getCommunity, getDb, insertComments, setDirectorySafeForWork, setNsfwOverrides, upsertCommunity } =
  await import('./db/index.js');

/** A community the previous run resolved NSFW, and stored as such. */
function storedNsfw(address: string, safeForWork?: number): void {
  upsertCommunity(safeForWork === undefined ? { address } : { address, safe_for_work: safeForWork });
  getDb().prepare('UPDATE communities SET nsfw = 1 WHERE address = ?').run(address);
}

const nsfw = (address: string) => getCommunity(address)?.nsfw;

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('startup keeps a stored directory verdict until the directory has been read', () => {
  storedNsfw('dir-only.bso');
  // What startNsfwOverrides does before the server starts listening.
  setNsfwOverrides([]);
  assert.equal(nsfw('dir-only.bso'), 1, 'not lowered on the strength of an empty, unread directory');
});

test('a directory that cannot be read changes nothing, and is retried until it is read', async () => {
  setPkcClientForTest(
    Promise.resolve({
      getCommunity: async () => ({ posts: { pages: { new: { comments: [] } } } }),
      getComment: async () => ({}),
      destroy: async () => {},
    }),
  );
  try {
    await startCrawler(); // the defaults file is missing, and the first pass re-resolves every community
    assert.equal(nsfw('dir-only.bso'), 1, 'a failed read is not an empty directory');

    // The source comes back, now saying the board is safe for work.
    writeFileSync(join(dir, '5chan-a-directory.json'), JSON.stringify({ boards: [{ address: 'dir-only.bso' }] }));
    writeFileSync(
      join(dir, '5chan-directories-defaults.json'),
      JSON.stringify({ directories: { a: { directoryCode: 'a', features: { safeForWork: true } } } }),
    );
    await until(() => nsfw('dir-only.bso') === 0);

    // Read in full, so the retries stop: like a first read that succeeds, the
    // directory is not re-read until the next restart.
    writeFileSync(
      join(dir, '5chan-directories-defaults.json'),
      JSON.stringify({ directories: { a: { directoryCode: 'a', features: { safeForWork: false } } } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(nsfw('dir-only.bso'), 0);
  } finally {
    stopCrawler();
    setPkcClientForTest(null);
  }
});

test('a partial read applies NSFW verdicts and lowers nothing until every list is read', () => {
  storedNsfw('dir-only.bso');
  storedNsfw('unread-list.bso');
  storedNsfw('read-sfw.bso');
  upsertCommunity({ address: 'newly-listed.bso' });
  upsertCommunity({ address: 'flagged.bso' });
  insertComments([
    { cid: 'restart-flagged', community_address: 'flagged.bso', post_cid: 'restart-flagged', depth: 0, timestamp: 1, nsfw: true },
  ]);

  // One directory's list could not be fetched.
  setDirectorySafeForWork(
    [
      { address: 'dir-only.bso', safeForWork: false },
      { address: 'read-sfw.bso', safeForWork: true },
      { address: 'newly-listed.bso', safeForWork: false },
    ],
    false,
  );
  assert.equal(nsfw('newly-listed.bso'), 1, 'an NSFW verdict that was read applies at once');
  assert.equal(nsfw('flagged.bso'), 1, 'so does inference');
  assert.equal(nsfw('dir-only.bso'), 1);
  assert.equal(nsfw('unread-list.bso'), 1, 'an address the read did not reach keeps its stored verdict');
  // The unread list may name it NSFW too, and the stricter verdict wins.
  assert.equal(nsfw('read-sfw.bso'), 1, 'a safe-for-work verdict is not final while a list is unread');
});

test('signals that outrank the directory still decide while it is unread', () => {
  storedNsfw('declared-sfw.bso', 1);
  storedNsfw('overridden.bso');
  setNsfwOverrides([{ address: 'overridden.bso', nsfw: false, reason: null }]);
  assert.equal(nsfw('declared-sfw.bso'), 0, "the owner's own safeForWork:true");
  assert.equal(nsfw('overridden.bso'), 0, 'the operator override');
  assert.equal(nsfw('unread-list.bso'), 1, 'still nothing outranks the unread directory here');
  setNsfwOverrides([]);
});

test('a complete read settles every address', () => {
  setDirectorySafeForWork([
    { address: 'dir-only.bso', safeForWork: false },
    { address: 'read-sfw.bso', safeForWork: true },
    { address: 'flagged.bso', safeForWork: true },
  ]);
  assert.equal(nsfw('dir-only.bso'), 1);
  assert.equal(nsfw('read-sfw.bso'), 0);
  assert.equal(nsfw('flagged.bso'), 0, 'the directory outranks inference');
  assert.equal(nsfw('unread-list.bso'), 0, 'listed nowhere, nothing flagged');
  assert.equal(nsfw('newly-listed.bso'), 0, 'no longer listed, nothing flagged');
});
