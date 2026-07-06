import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
const { mapComment } = await import('./crawler.js');

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
