import assert from 'node:assert/strict';
import test from 'node:test';
import { positiveDuration } from './config.js';

test('positiveDuration preserves its fallback and accepts finite positive values', () => {
  assert.equal(positiveDuration(undefined, 300_000, 'TIMEOUT'), 300_000);
  assert.equal(positiveDuration('5000', 300_000, 'TIMEOUT'), 5000);
});

test('positiveDuration rejects values that cannot provide a real timeout', () => {
  for (const value of ['0', '-1', 'NaN', 'Infinity']) {
    assert.throws(
      () => positiveDuration(value, 300_000, 'TIMEOUT'),
      /TIMEOUT must be a finite positive number of milliseconds/,
    );
  }
});
