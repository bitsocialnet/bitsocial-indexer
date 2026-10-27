import assert from 'node:assert/strict';
import test from 'node:test';
import { positiveDuration } from './config.js';

test('positiveDuration preserves its fallback and accepts finite positive values', () => {
  assert.equal(positiveDuration(undefined, 300_000, 'TIMEOUT'), 300_000);
  assert.equal(positiveDuration('5000', 300_000, 'TIMEOUT'), 5000);
});

test('positiveDuration rejects values that cannot provide a real timeout', () => {
  // Above 2147483647 a Node timer fires after 1ms instead, so a reload would spin.
  for (const value of ['0', '-1', 'NaN', 'Infinity', '0.5', '2147483648']) {
    assert.throws(
      () => positiveDuration(value, 300_000, 'TIMEOUT'),
      /TIMEOUT must be a whole number of milliseconds from 1 to 2147483647/,
    );
  }
  assert.equal(positiveDuration('2147483647', 300_000, 'TIMEOUT'), 2_147_483_647);
});
