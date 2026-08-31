import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
const { loadNsfwOverrides, parseNsfwOverrides, pollNsfwOverrides } = await import('./nsfw.js');
const {
  getCommunity,
  insertComments,
  resolveNsfw,
  setDirectorySafeForWork,
  setNsfwOverrides,
  upsertCommunity,
} = await import('./db/index.js');

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

test('resolveNsfw lets the operator override every other signal, in both directions', () => {
  assert.equal(resolveNsfw({ override: true, safeForWork: true, directorySafeForWork: true, inferred: false }), true);
  assert.equal(resolveNsfw({ override: false, safeForWork: false, directorySafeForWork: false, inferred: true }), false);
});

test("resolveNsfw prefers the community's own safeForWork over the directory and inference", () => {
  assert.equal(resolveNsfw({ safeForWork: false, directorySafeForWork: true, inferred: false }), true);
  assert.equal(resolveNsfw({ safeForWork: true, directorySafeForWork: false, inferred: true }), false);
});

test('resolveNsfw prefers the directory verdict over inference, in both directions', () => {
  assert.equal(resolveNsfw({ directorySafeForWork: false, inferred: false }), true);
  assert.equal(resolveNsfw({ directorySafeForWork: true, inferred: true }), false);
});

test('resolveNsfw treats an unset safeForWork as no opinion, not as true or false', () => {
  // Unset must fall through to the next signal — the distinction the whole
  // three-state flag exists for.
  assert.equal(resolveNsfw({ safeForWork: undefined, directorySafeForWork: false, inferred: false }), true);
  assert.equal(resolveNsfw({ safeForWork: undefined, directorySafeForWork: true, inferred: true }), false);
  assert.equal(resolveNsfw({ safeForWork: undefined, directorySafeForWork: undefined, inferred: true }), true);
});

test('resolveNsfw falls back to inference when nothing above it has an opinion', () => {
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
  setDirectorySafeForWork([]); // any signal change re-resolves every community
  assert.equal(getCommunity('infer.bso')?.nsfw, 1);
});

test('a directory saying safeForWork:true overrules a flagged comment', () => {
  setDirectorySafeForWork([{ address: 'infer.bso', safeForWork: true }]);
  assert.equal(getCommunity('infer.bso')?.nsfw, 0);
});

test('a directory can mark a community with no flagged content NSFW', () => {
  upsertCommunity({ address: 'listed.bso' });
  setDirectorySafeForWork([{ address: 'listed.bso', safeForWork: false }]);
  assert.equal(getCommunity('listed.bso')?.nsfw, 1);
});

test('an address in no directory is left to inference', () => {
  setDirectorySafeForWork([]);
  assert.equal(getCommunity('infer.bso')?.nsfw, 1, 'flagged content still infers NSFW');
  assert.equal(getCommunity('listed.bso')?.nsfw, 0, 'nothing flagged, no directory verdict');
});

test('an address listed under two directories takes the stricter verdict', () => {
  upsertCommunity({ address: 'both.bso' });
  setDirectorySafeForWork([
    { address: 'both.bso', safeForWork: true },
    { address: 'both.bso', safeForWork: false },
  ]);
  assert.equal(getCommunity('both.bso')?.nsfw, 1);
  setDirectorySafeForWork([]);
});

// ── the community's own features.safeForWork ─────────────────────────────────

test("a community's own safeForWork:false marks it NSFW without any flagged content", () => {
  upsertCommunity({ address: 'declared.bso', safe_for_work: 0 });
  assert.equal(getCommunity('declared.bso')?.safe_for_work, 0);
  setDirectorySafeForWork([]);
  assert.equal(getCommunity('declared.bso')?.nsfw, 1);
});

test("a community's own safeForWork outranks the directory, in both directions", () => {
  upsertCommunity({ address: 'declared-sfw.bso', safe_for_work: 1 });
  setDirectorySafeForWork([
    { address: 'declared.bso', safeForWork: true },
    { address: 'declared-sfw.bso', safeForWork: false },
  ]);
  assert.equal(getCommunity('declared.bso')?.nsfw, 1, 'the owner said NSFW, the directory said otherwise');
  assert.equal(getCommunity('declared-sfw.bso')?.nsfw, 0, 'the owner said SFW, the directory said otherwise');
  setDirectorySafeForWork([]);
});

test('an unset safeForWork falls through to the directory, then to inference', () => {
  upsertCommunity({ address: 'undeclared.bso' });
  assert.equal(getCommunity('undeclared.bso')?.safe_for_work, null, 'never crawled = never declared');

  setDirectorySafeForWork([{ address: 'undeclared.bso', safeForWork: false }]);
  assert.equal(getCommunity('undeclared.bso')?.nsfw, 1, 'the directory answers for it');

  setDirectorySafeForWork([]);
  assert.equal(getCommunity('undeclared.bso')?.nsfw, 0, 'nothing flagged, so nothing to infer');
});

test('scheduling a community again never erases an observed safeForWork', () => {
  upsertCommunity({ address: 'declared.bso', added_at: 1 }); // no safe_for_work key
  assert.equal(getCommunity('declared.bso')?.safe_for_work, 0, 'the crawl-observed declaration survives');

  // A later crawl finding the feature removed is a real observation of "unset".
  upsertCommunity({ address: 'declared.bso', safe_for_work: null });
  assert.equal(getCommunity('declared.bso')?.safe_for_work, null);
  setDirectorySafeForWork([]);
  assert.equal(getCommunity('declared.bso')?.nsfw, 0);
});

test('an operator override outranks the community-declared safeForWork', () => {
  upsertCommunity({ address: 'declared.bso', safe_for_work: 0 });
  setNsfwOverrides([{ address: 'declared.bso', nsfw: false, reason: 'operator call' }]);
  assert.equal(getCommunity('declared.bso')?.nsfw, 0);
  setNsfwOverrides([]);
  assert.equal(getCommunity('declared.bso')?.nsfw, 1);
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
