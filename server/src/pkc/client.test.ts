import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPkcRpcUrlForLog, resetPkcClient, setPkcClientForTest, type PkcClient } from './client.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function client(destroy: () => Promise<void>): PkcClient {
  return {
    getCommunity: async () => ({}),
    getComment: async () => ({}),
    destroy,
  };
}

test('PKC RPC log target preserves a credential-free local endpoint', () => {
  assert.equal(formatPkcRpcUrlForLog('ws://localhost:9138'), 'ws://localhost:9138');
  assert.equal(formatPkcRpcUrlForLog('ws://127.0.0.1:9138/'), 'ws://127.0.0.1:9138');
});

test('PKC RPC log target redacts auth paths, userinfo, queries, and fragments', () => {
  assert.equal(
    formatPkcRpcUrlForLog('wss://operator:password@example.com:9138/remote-auth-key?token=secret#credential'),
    'wss://example.com:9138/[redacted]',
  );
});

test('PKC RPC log target does not echo malformed or unsupported URLs', () => {
  assert.equal(formatPkcRpcUrlForLog('not a URL with secret material'), '[invalid PKC RPC URL]');
  assert.equal(formatPkcRpcUrlForLog('https://example.com/secret'), '[invalid PKC RPC URL]');
});

test('a second reset retires a replacement installed while the first reset is pending', async () => {
  const firstDestroy = deferred();
  const secondDestroy = deferred();
  let firstDestroyed = 0;
  let secondDestroyed = 0;

  setPkcClientForTest(
    Promise.resolve(
      client(async () => {
        firstDestroyed++;
        await firstDestroy.promise;
      }),
    ),
  );
  const resetA = resetPkcClient();
  await Promise.resolve();
  assert.equal(firstDestroyed, 1);

  setPkcClientForTest(
    Promise.resolve(
      client(async () => {
        secondDestroyed++;
        await secondDestroy.promise;
      }),
    ),
  );
  const resetB = resetPkcClient();
  await Promise.resolve();
  assert.equal(secondDestroyed, 1);
  assert.notEqual(resetB, resetA);

  firstDestroy.resolve();
  secondDestroy.resolve();
  await Promise.all([resetA, resetB]);
  setPkcClientForTest(null);
});
