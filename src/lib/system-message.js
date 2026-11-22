/**
 * Helpers for platform System Member messages (调度中心 等播报源).
 *
 * A System Member is a trusted, write-only platform broadcast identity
 * (`sender_type=SYSTEM`). It is NOT a human/agent participant, so the dmPolicy /
 * groupPolicy / owner-binding gates that exist to filter human/agent senders
 * must not apply to it — see comm-bridge `shouldHandleMessage`.
 *
 * Wire shape (目标环境实测，DM <dm-id> 的 SYSTEM 消息)：
 *   { sender_type: "SYSTEM", type: "TEXT",
 *     content: { content_type: "text", body: { text: "[调度中心] …" } } }
 * 优先级先读 `metadata.context` 的 `priority` item（message context phase 2，
 * cws-work 写 `attrs.level`），没有可用 item 时回退旧的
 * `metadata.systemEvent.priority`；两者都没有 → 不带 --priority，c4-receive
 * 默认 normal。只对 SYSTEM 发送者生效（见 inboundPriority）。
 *
 * 设计依据：cws-docs/architecture/v0.7-event-delivery-design.md §5 / §6.3。
 */

import { agentContextItem } from './message-context.js';

// priority item attrs.level, else metadata.systemEvent.priority
// (urgent|high|normal) → c4-receive --priority(1|2|3)
const PRIORITY_BY_NAME = { urgent: 1, high: 2, normal: 3 };

/**
 * Whether a message was sent by a platform System Member.
 * Reads both the top-level `sender_type` (real-time WS frames) and the nested
 * `message.sender_type` (get-message detail envelope), so detection is uniform
 * regardless of arrival path.
 */
export function isSystemSender(msg) {
  if (!msg) return false;
  const t = String(msg.sender_type || msg.message?.sender_type || '').toUpperCase();
  return t === 'SYSTEM';
}

// sender_type of a human / agent participant → <sender-context kind="…">.
const MEMBER_KIND = { HUMAN: 'human', AGENT: 'agent' };

/**
 * The sender of a human / agent message as `{ kind: 'human'|'agent', memberId }`,
 * for the DM `<sender-context kind="human|agent" member-id="…"/>` element.
 * Reads `sender_type` / `sender_id` the same two ways as isSystemSender (top
 * level, then `message.*`); both are filled by cws-comm from the authenticated
 * principal. SYSTEM (handled by isSystemSender), an unknown or missing
 * sender_type, or a missing sender_id → `undefined`: no kind is guessed.
 */
export function senderMemberFrom(msg) {
  if (!msg) return undefined;
  const t = String(msg.sender_type || msg.message?.sender_type || '').toUpperCase();
  const kind = MEMBER_KIND[t];
  const memberId = msg.sender_id || msg.message?.sender_id;
  return kind && memberId ? { kind, memberId } : undefined;
}

/**
 * c4-receive `--priority` (1=urgent / 2=high / 3=normal) for a system message.
 * Read first from the `priority` item of `metadata.context` (audience=agent,
 * `attrs.level`; message context phase 2), else from
 * `metadata.systemEvent.priority` wherever cws-core surfaces it.
 * An item whose `level` is missing or unrecognized is treated as invalid and
 * falls back to the old `metadata.systemEvent.priority` (message context plan
 * §1.1: an invalid item falls back to the old logic).
 * Returns `undefined` when neither gives a priority (caller then omits the
 * flag and c4-receive applies its default of 3). An unrecognized priority on a
 * present systemEvent degrades to 3 (normal).
 */
export function systemEventPriority(msg) {
  const item = agentContextItem(msg, 'priority');
  const fromItem = item && PRIORITY_BY_NAME[String(item.attrs.level ?? '').toLowerCase()];
  if (fromItem) return fromItem;
  const se =
       msg?.content?.metadata?.systemEvent
    || msg?.metadata?.systemEvent
    || msg?.message?.content?.metadata?.systemEvent;
  if (!se) return undefined;
  return PRIORITY_BY_NAME[String(se.priority || '').toLowerCase()] || 3;
}

/**
 * c4-receive `--priority` for an inbound message: the `priority` context item
 * (else `metadata.systemEvent.priority`) counts only on a message from a
 * platform System Member (isSystemSender); its `source` is not read.
 * `metadata` is written by the sender, so on any other message both are
 * ignored and the default applies (undefined → c4-receive's normal, 3);
 * otherwise anyone could mark their own message urgent.
 */
export function inboundPriority(msg) {
  return isSystemSender(msg) ? systemEventPriority(msg) : undefined;
}
