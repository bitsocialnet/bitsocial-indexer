import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
const { loadNsfwOverrides, parseNsfwOverrides, pollNsfwOverrides } = await import('./nsfw.js');
const { getCommunity, insertComments, resolveNsfw, setNsfwList, setNsfwOverrides, upsertCommunity } = await import(
  './db/index.js'
);

const dir = mkdtempSync(join(tmpdir(), 'indexer-nsfw-'));
const file = join(dir, 'nsfw.json');
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** Write the file with a strictly increasing mtime so the poller sees a change. */
let fakeTime = Math.floor(Date.now() / 1000);
function writeOverrides(entries: unknown): void {
  writeFileSync(file, JSON.stringify(entries));
  utimesSync(file, ++fakeTime, fakeTime);
}

// ── precedence ───────────────────────────────────────────────────────────────

test('resolveNsfw lets the operator override both mark and clear a community', () => {
  assert.equal(resolveNsfw({ override: true, listed: false, inferred: false }), true);
  assert.equal(resolveNsfw({ override: false, listed: true, inferred: true }), false);
});

test('resolveNsfw prefers the directory list over inference, in both directions', () => {
  assert.equal(resolveNsfw({ listed: true, inferred: false }), true);
  assert.equal(resolveNsfw({ listed: false, inferred: true }), false);
});

test('resolveNsfw falls back to inference when no list or operator says anything', () => {
  assert.equal(resolveNsfw({ inferred: true }), true);
  assert.equal(resolveNsfw({ inferred: false }), false);
});

// ── file format ──────────────────────────────────────────────────────────────

test('parseNsfwOverrides accepts bare addresses and objects, defaulting nsfw to true', () => {
  const entries = parseNsfwOverrides([
    'bare.bso',
    { address: 'obj.bso' },
    { address: 'clear.bso', nsfw: false, reason: 'one flagged post' },
  ]);
  assert.deepEqual(entries, [
    { address: 'bare.bso', nsfw: true, reason: null },
    { address: 'obj.bso', nsfw: true, reason: null },
    { address: 'clear.bso', nsfw: false, reason: 'one flagged post' },
  ]);
});

test('parseNsfwOverrides skips invalid entries and rejects non-arrays', () => {
  assert.deepEqual(parseNsfwOverrides([42, {}, '', { nsfw: true }, { address: '  ' }]), []);
  assert.throws(() => parseNsfwOverrides({ communities: [] }));
});

test('loadNsfwOverrides reads and normalizes a JSON file', async () => {
  writeOverrides(['from-file.bso', { address: 'sfw.bso', nsfw: false }]);
  assert.deepEqual(await loadNsfwOverrides(file), [
    { address: 'from-file.bso', nsfw: true, reason: null },
    { address: 'sfw.bso', nsfw: false, reason: null },
  ]);
});

// ── the three signals, applied ───────────────────────────────────────────────

test('a community with a flagged comment is inferred NSFW', () => {
  upsertCommunity({ address: 'infer.bso' });
  assert.equal(getCommunity('infer.bso')?.nsfw, 0);

  insertComments([
    { cid: 'infer-op', community_address: 'infer.bso', post_cid: 'infer-op', depth: 0, timestamp: 1, nsfw: true },
  ]);
  setNsfwList([]); // any signal change re-resolves every community
  assert.equal(getCommunity('infer.bso')?.nsfw, 1);
});

test('a directory list saying nsfw:false overrules a flagged comment', () => {
  setNsfwList([{ address: 'infer.bso', nsfw: false }]);
  assert.equal(getCommunity('infer.bso')?.nsfw, 0);
});

test('a directory list can mark a community with no flagged content NSFW', () => {
  upsertCommunity({ address: 'listed.bso' });
  setNsfwList([{ address: 'listed.bso', nsfw: true }]);
  assert.equal(getCommunity('listed.bso')?.nsfw, 1);
});

test('a list entry with no nsfw field leaves the community to inference', () => {
  setNsfwList([{ address: 'infer.bso' }, { address: 'listed.bso' }]);
  assert.equal(getCommunity('infer.bso')?.nsfw, 1, 'flagged content still infers NSFW');
  assert.equal(getCommunity('listed.bso')?.nsfw, 0, 'nothing flagged, nothing listed');
});

test('pollNsfwOverrides applies the file, picks up changes, and clears on deletion', async () => {
  // 1. File appears forcing a community NSFW that nothing else marks.
  writeOverrides([{ address: 'listed.bso', reason: 'operator call' }]);
  await pollNsfwOverrides(file);
  assert.equal(getCommunity('listed.bso')?.nsfw, 1);

  // 2. Unchanged mtime → the poller does not reapply.
  setNsfwOverrides([]);
  await pollNsfwOverrides(file);
  assert.equal(getCommunity('listed.bso')?.nsfw, 0, 'no reload while mtime is unchanged');

  // 3. mtime bump clearing a community the content signal marked NSFW.
  writeOverrides([{ address: 'infer.bso', nsfw: false }]);
  await pollNsfwOverrides(file);
  assert.equal(getCommunity('infer.bso')?.nsfw, 0, 'operator corrects a bad inference');

  // 4. A broken file keeps the previous overrides.
  writeFileSync(file, 'not json{');
  utimesSync(file, ++fakeTime, fakeTime);
  await pollNsfwOverrides(file);
  assert.equal(getCommunity('infer.bso')?.nsfw, 0, 'broken file keeps last good overrides');

  // 5. Entry removed → the community falls back to inference.
  writeOverrides([]);
  await pollNsfwOverrides(file);
  assert.equal(getCommunity('infer.bso')?.nsfw, 1);

  // 6. File deleted entirely → overrides cleared.
  writeOverrides([{ address: 'infer.bso', nsfw: false }]);
  await pollNsfwOverrides(file);
  assert.equal(getCommunity('infer.bso')?.nsfw, 0);
  rmSync(file);
  await pollNsfwOverrides(file);
  assert.equal(getCommunity('infer.bso')?.nsfw, 1);
});
