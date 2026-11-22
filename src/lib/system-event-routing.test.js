import assert from 'node:assert/strict';
import test from 'node:test';

import { isSenderlessUpdate } from './system-event-routing.js';

const frame = (data) => ({ event: 'message.updated', conversation_id: 'cv-1', data });

test('isSenderlessUpdate: only a message.updated carrying a cause is skipped', () => {
  assert.equal(isSenderlessUpdate(frame({ message_id: 7, edited_by: 'm-1', cause: 'quote_excerpt_recalled' })), true);
  assert.equal(isSenderlessUpdate(frame({ message_id: 7, edited_by: 'm-1' })), false);
  assert.equal(isSenderlessUpdate(frame({ message_id: 7, cause: '' })), false);
  assert.equal(isSenderlessUpdate(frame({ message_id: 7, cause: true })), false);
  assert.equal(isSenderlessUpdate({ event: 'message.updated', conversation_id: 'cv-1' }), false);
});
