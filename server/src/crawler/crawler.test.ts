import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
const { CrawlTimeoutError, mapComment, runWithConcurrency, withTimeout } = await import('./crawler.js');

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
