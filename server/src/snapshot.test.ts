import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

process.env.DB_PATH = ':memory:';
const { exportSnapshot, SNAPSHOT_FORMAT } = await import('./snapshot.js');
const { getThread, insertComments, setBlocklist, upsertCommunity } = await import('./db/index.js');

const dir = mkdtempSync(join(tmpdir(), 'indexer-snapshot-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const raw = (cid: string) => JSON.stringify({ cid, signature: 'sig' });

upsertCommunity({ address: 'snap.bso', title: 'Snapshot board' });
insertComments([
  { cid: 'op', community_address: 'snap.bso', post_cid: 'op', depth: 0, timestamp: 10, title: 'kept title', content: 'kept body', author_name: 'anon', author_address: 'addr-op', link: 'https://example.com/a.png', raw: raw('op') },
  { cid: 'live', community_address: 'snap.bso', post_cid: 'op', parent_cid: 'op', depth: 1, timestamp: 11, content: 'live reply', author_address: 'addr-live', raw: raw('live') },
  { cid: 'removed', community_address: 'snap.bso', post_cid: 'op', parent_cid: 'op', depth: 1, timestamp: 12, content: 'mod removed this', author_address: 'addr-removed', removed: true, mod_reason: 'rule 1', raw: raw('removed') },
  { cid: 'deleted', community_address: 'snap.bso', post_cid: 'op', parent_cid: 'op', depth: 1, timestamp: 13, content: 'author deleted this', author_address: 'addr-deleted', deleted: true, raw: raw('deleted') },
  { cid: 'stored-takedown', community_address: 'snap.bso', post_cid: 'op', parent_cid: 'op', depth: 1, timestamp: 14, content: 'stored takedown body', author_address: 'addr-st', raw: raw('stored-takedown') },
  { cid: 'file-takedown', community_address: 'snap.bso', post_cid: 'op', parent_cid: 'op', depth: 1, timestamp: 15, content: 'file takedown body', author_address: 'addr-ft', raw: raw('file-takedown') },
  { cid: 'op2', community_address: 'snap.bso', post_cid: 'op2', depth: 0, timestamp: 20, title: 'whole thread gone', content: 'thread body', raw: raw('op2') },
  { cid: 'op2-reply', community_address: 'snap.bso', post_cid: 'op2', parent_cid: 'op2', depth: 1, timestamp: 21, content: 'thread reply body', raw: raw('op2-reply') },
]);
// Approved once, then flagged as pending by a later update: kept as a row, never served.
insertComments([{ cid: 'pending', community_address: 'snap.bso', post_cid: 'op', parent_cid: 'op', depth: 1, timestamp: 16, content: 'queued body' }]);
insertComments([{ cid: 'pending', community_address: 'snap.bso', post_cid: 'op', parent_cid: 'op', depth: 1, timestamp: 16, pending_approval: true }]);
// The running server already applied this takedown to the database.
setBlocklist([{ cid: 'stored-takedown', scope: 'comment', reason: 'DMCA stored' }]);

/** A blocklist file holding entries the server has not polled yet. */
const blocklistFile = join(dir, 'blocklist.json');
writeFileSync(
  blocklistFile,
  JSON.stringify([
    { cid: 'file-takedown', reason: 'DMCA file' },
    { cid: 'op2', scope: 'thread', reason: 'court order' },
  ]),
);

type Row = Record<string, unknown>;
function readLines(path: string): Row[] {
  return gunzipSync(readFileSync(path))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
}

const REDACTED = ['title', 'content', 'link', 'thumbnail_url', 'author_address', 'author_name', 'raw'];

test('a snapshot holds what the API serves, with tombstones and file takedowns redacted', async () => {
  const out = join(dir, 'full');
  const manifest = await exportSnapshot(out, blocklistFile);

  assert.deepEqual(readdirSync(out).sort(), ['comments.jsonl.gz', 'communities.jsonl.gz', 'manifest.json']);
  const comments = readLines(join(out, 'comments.jsonl.gz'));
  const byCid = new Map(comments.map((c) => [c.cid, c]));

  assert.equal(byCid.has('pending'), false, 'mod-queue content is never exported');
  const text = gunzipSync(readFileSync(join(out, 'comments.jsonl.gz'))).toString('utf8');
  for (const secret of ['queued body', 'mod removed this', 'author deleted this', 'stored takedown body', 'file takedown body', 'thread body', 'thread reply body', 'addr-removed', 'addr-ft']) {
    assert.equal(text.includes(secret), false, `"${secret}" must not appear in the snapshot`);
  }

  for (const cid of ['removed', 'deleted', 'stored-takedown', 'file-takedown', 'op2', 'op2-reply']) {
    const row = byCid.get(cid);
    assert.ok(row, `${cid} stays as a tombstone`);
    for (const field of REDACTED) assert.equal(row[field], null, `${cid}.${field} is redacted`);
  }
  assert.equal(byCid.get('removed')?.removed, 1);
  assert.equal(byCid.get('removed')?.mod_reason, 'rule 1');
  assert.equal(byCid.get('stored-takedown')?.takedown_reason, 'DMCA stored');
  assert.equal(byCid.get('file-takedown')?.takedown, 1);
  assert.equal(byCid.get('file-takedown')?.takedown_reason, 'DMCA file');
  assert.equal(byCid.get('op2-reply')?.takedown_reason, 'court order');

  const op = byCid.get('op');
  assert.equal(op?.content, 'kept body');
  assert.equal(op?.link, 'https://example.com/a.png');
  assert.equal(op?.raw, raw('op'));
  assert.equal(op?.archived, 0);
  assert.equal(byCid.get('live')?.content, 'live reply');

  // Grouped by thread, original post first.
  assert.deepEqual(
    comments.map((c) => c.cid),
    ['op', 'live', 'removed', 'deleted', 'stored-takedown', 'file-takedown', 'op2', 'op2-reply'],
  );

  const communities = readLines(join(out, 'communities.jsonl.gz'));
  assert.deepEqual(communities.map((c) => c.address), ['snap.bso']);

  const onDisk = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as typeof manifest;
  assert.deepEqual(onDisk, manifest);
  assert.equal(manifest.format, SNAPSHOT_FORMAT);
  assert.equal(manifest.blocklist_file_applied, true);
  for (const [name, file] of Object.entries(manifest.files)) {
    const bytes = readFileSync(join(out, name));
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'), `${name} checksum`);
    assert.equal(file.bytes, bytes.length);
  }
  assert.equal(manifest.files['comments.jsonl.gz'].records, comments.length);
  assert.equal(manifest.files['communities.jsonl.gz'].records, 1);
});

test('the export leaves the database untouched', async () => {
  await exportSnapshot(join(dir, 'readonly'), blocklistFile);
  // The file-only takedown was applied to the snapshot, not to the stored rows.
  const reply = getThread('op')?.replies.find((r) => r.cid === 'file-takedown');
  assert.equal(reply?.takedown, 0);
  assert.equal(reply?.content, 'file takedown body');
});

test('without BLOCKLIST_SOURCE, stored takedowns still apply and are never lifted', async () => {
  const out = join(dir, 'no-file');
  const manifest = await exportSnapshot(out, '');
  assert.equal(manifest.blocklist_file_applied, false);
  const row = readLines(join(out, 'comments.jsonl.gz')).find((c) => c.cid === 'stored-takedown');
  assert.equal(row?.takedown, 1);
  assert.equal(row?.content, null);
  assert.equal(getThread('op')?.replies.find((r) => r.cid === 'stored-takedown')?.takedown, 1);
});

test('a configured blocklist that cannot be read aborts without leaving output', async () => {
  const out = join(dir, 'broken');
  await assert.rejects(exportSnapshot(out, join(dir, 'missing.json')), /BLOCKLIST_SOURCE/);
  const invalid = join(dir, 'invalid.json');
  writeFileSync(invalid, '{ not json');
  await assert.rejects(exportSnapshot(out, invalid), /BLOCKLIST_SOURCE/);
  assert.equal(existsSync(out), false);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
});

test('an existing output directory is never overwritten', async () => {
  const out = join(dir, 'taken');
  mkdirSync(out);
  writeFileSync(join(out, 'keep.txt'), 'operator file');
  await assert.rejects(exportSnapshot(out, ''), /already exists/);
  assert.deepEqual(readdirSync(out), ['keep.txt']);
});
