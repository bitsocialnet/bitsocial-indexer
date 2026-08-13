import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPkcRpcUrlForLog } from './client.js';

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
