/**
 * Classification + in-code routing of inbound `system` frames, extracted from
 * comm-bridge.js (which self-executes on import) so it is unit-testable.
 *
 * Event-name strings are cws-comm's authoritative domain event constants
 * (cws-comm internal/domain/message_events.go, *.EventName()):
 *   "message.recalled" / "message.deleted" -> recall
 *   "message.updated"                       -> edit  (NB: cws-comm names edit
 *                                              "updated", not "edited")
 * Ignored (return null): message.created / .read / .delivered /
 *   .reaction.added / .reaction.removed / .mention.created.
 * Exact match keeps us in lock-step with the contract; the substring fallback
 * only guards against a future rename (e.g. a "message.edited" alias).
 */

import { IM_OWNER_NOTICE_EVENT, IM_OWNER_NOTICE_TYPE, noticeFromSystemFrame } from './im-owner-notice.js';
import { isChannelEvent } from './channel-connector.js';
import { CARD_RECORDED_EVENT } from './receipt-watch.js';
import { AGENT_DIAGNOSTICS_EVENT } from './diagnostics.js';

export function classifySystemEvent(eventName) {
  const e = String(eventName || '').toLowerCase();
  // IM owner notice: matched first so no prefix/substring rule can claim it.
  if (e === IM_OWNER_NOTICE_EVENT) return IM_OWNER_NOTICE_TYPE;
  if (e === 'message.recalled' || e === 'message.deleted') return 'recall';
  if (e === 'message.updated') return 'edit';
  if (e.startsWith('agent.config.')) return 'config_update';
  if (e === AGENT_DIAGNOSTICS_EVENT) return 'diagnostics';
  // Thin "card flipped" lifecycle event — not the answer (that is the
  // interaction receipt). Handled by the dispatcher's lost-receipt watcher.
  if (e === CARD_RECORDED_EVENT) return 'card_settled';
  if (e.startsWith('connection.')) return 'connection';
  if (isChannelEvent(e)) return 'channel';
  // Defensive fallback for naming drift — does not match reaction/read/etc.
  if (e.includes('recall') || e.includes('delete')) return 'recall';
  if (e.includes('edit') || e.includes('updat')) return 'edit';
  return null;
}

/**
 * A `message.updated` whose `data.cause` is set is a change the sender did not
 * make (e.g. "quote_excerpt_recalled": cws-comm tombstoned a quoted excerpt);
 * body and edited_at are unchanged, so it must not reach the agent as an edit.
 */
export function isSenderlessUpdate(payload) {
  const cause = payload?.data?.cause;
  return typeof cause === 'string' && cause !== '';
}

/**
 * Handle an IM-owner notice system frame in code (never forwarded to C4 / the
 * model, never arrears-gated). Returns true when the frame was an IM-owner
 * notice (handled or dropped as malformed), false for any other event.
 */
export async function routeImOwnerNotice(frame, { onNotice, warn = () => {} }) {
  if (classifySystemEvent(frame?.payload?.event) !== IM_OWNER_NOTICE_TYPE) return false;
  const notice = noticeFromSystemFrame(frame);
  if (!notice) {
    warn(`${IM_OWNER_NOTICE_EVENT}: missing data, skip`);
    return true;
  }
  await onNotice(notice);
  return true;
}
