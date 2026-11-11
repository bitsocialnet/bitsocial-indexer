import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// An instance that serves its archive with crawling paused (no COMMUNITIES, no
// COMMUNITIES_SOURCE) but a directory still configured. No stored NSFW flag is
// lowered until the directory has been read, so the idle crawler must read it.
const dir = mkdtempSync(join(tmpdir(), 'indexer-nsfw-idle-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(
  join(dir, '5chan-directories-defaults.json'),
  JSON.stringify({
    directories: {
      b: { directoryCode: 'b', features: { safeForWork: false } },
      a: { directoryCode: 'a', features: { safeForWork: true } },
    },
  }),
);
writeFileSync(join(dir, '5chan-b-directory.json'), JSON.stringify(['dir-nsfw.bso']));
writeFileSync(join(dir, '5chan-a-directory.json'), JSON.stringify(['dir-sfw.bso']));
process.env.DB_PATH = ':memory:';
process.env.DIRECTORY_DEFAULTS_SOURCE = join(dir, '5chan-directories-defaults.json');
process.env.COMMUNITIES = '';
process.env.COMMUNITIES_SOURCE = '';

const { startCrawler, stopCrawler } = await import('./crawler/crawler.js');
const { getCommunity, getDb, setNsfwOverrides, upsertCommunity } = await import('./db/index.js');

/** A community the previous run resolved NSFW, and stored as such. */
function storedNsfw(address: string): void {
  upsertCommunity({ address });
  getDb().prepare('UPDATE communities SET nsfw = 1 WHERE address = ?').run(address);
}

const nsfw = (address: string) => getCommunity(address)?.nsfw;

test('an idle crawler still reads the directory, so stored NSFW flags can be lowered', async () => {
  storedNsfw('dir-nsfw.bso');
  storedNsfw('dir-sfw.bso');
  storedNsfw('overridden.bso');
  // What startNsfwOverrides does before the server starts listening.
  setNsfwOverrides([{ address: 'overridden.bso', nsfw: true, reason: null }]);
  try {
    await startCrawler();
    assert.equal(nsfw('dir-nsfw.bso'), 1, 'the NSFW directory verdict applies');
    assert.equal(nsfw('dir-sfw.bso'), 0, 'a complete read settles the safe-for-work one');

    // The operator lifts the override.
    setNsfwOverrides([]);
    assert.equal(nsfw('overridden.bso'), 0, 'removing the override lowers the flag');
  } finally {
    stopCrawler();
  }
});
