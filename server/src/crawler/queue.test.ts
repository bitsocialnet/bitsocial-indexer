import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
const { getDb } = await import('../db/index.js');
const { due, enqueue, markFailed, markRunning, markSuccess, reclaimAbandoned } = await import('./queue.js');

const nowSec = () => Math.floor(Date.now() / 1000);
const addresses = () => due().map((r) => r.community_address);

function reset(): void {
  getDb().exec('DELETE FROM crawl_queue');
}

/** Force a row into the state a given number of seconds ago. */
function claimedAgo(address: string, seconds: number): void {
  markRunning(address);
  getDb()
    .prepare(`UPDATE crawl_queue SET started_at = @then WHERE community_address = @address`)
    .run({ address, then: nowSec() - seconds });
}

test('a running community is skipped while its lease is live', () => {
  reset();
  enqueue('a.bso');
  enqueue('b.bso');
  markRunning('a.bso');
  assert.deepEqual(addresses(), ['b.bso']);
});

test('a running community becomes due again once its lease expires', () => {
  reset();
  enqueue('a.bso');
  // Well past the lease (2x the 300s default crawl timeout).
  claimedAgo('a.bso', 10_000);
  assert.deepEqual(addresses(), ['a.bso']);
});

test('a row claimed before started_at existed is treated as abandoned', () => {
  reset();
  enqueue('a.bso');
  markRunning('a.bso');
  getDb().exec(`UPDATE crawl_queue SET started_at = NULL WHERE community_address = 'a.bso'`);
  assert.deepEqual(addresses(), ['a.bso']);
});

test('reclaimAbandoned re-queues leases left by a dead process', () => {
  reset();
  enqueue('a.bso');
  enqueue('b.bso');
  markRunning('a.bso');
  assert.equal(reclaimAbandoned(), 1);
  assert.deepEqual(addresses().sort(), ['a.bso', 'b.bso']);
  assert.equal(reclaimAbandoned(), 0);
});

test('finishing a pass clears the lease', () => {
  reset();
  enqueue('a.bso');
  enqueue('b.bso');
  markRunning('a.bso');
  markSuccess('a.bso', nowSec() + 3600);
  markRunning('b.bso');
  markFailed('b.bso', 'boom', nowSec() + 3600);
  const rows = getDb().prepare('SELECT community_address, started_at FROM crawl_queue').all() as {
    community_address: string;
    started_at: number | null;
  }[];
  for (const row of rows) assert.equal(row.started_at, null, `${row.community_address} kept its lease`);
  // Both are scheduled into the future, so neither is due.
  assert.deepEqual(addresses(), []);
});

test('a success still due in the future is not re-crawled', () => {
  reset();
  enqueue('a.bso');
  markSuccess('a.bso', nowSec() + 3600);
  assert.deepEqual(addresses(), []);
});

test('enqueue pulls an existing future schedule forward for an immediate startup refresh', () => {
  reset();
  enqueue('a.bso');
  markSuccess('a.bso', nowSec() + 3600);
  assert.deepEqual(addresses(), []);
  enqueue('a.bso');
  assert.deepEqual(addresses(), ['a.bso']);
});
