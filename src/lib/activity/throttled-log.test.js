import assert from 'node:assert/strict';
import test from 'node:test';
import { createThrottledLogger } from './throttled-log.js';

test('at most one line per reason per 10 s; the next line carries the suppressed count', () => {
  let t = 0;
  const lines = [];
  const log = createThrottledLogger({ warn: (...a) => lines.push(a.join(' ')), now: () => t });
  assert.equal(log.warn('a', 'first'), true);
  for (let i = 0; i < 5; i++) log.warn('a', 'again');
  log.warn('b', 'other reason');
  assert.equal(lines.length, 2);
  t += 10_000;
  log.warn('a', 'later');
  assert.equal(lines.length, 3);
  assert.match(lines[2], /later \(5 suppressed\)/);
});
