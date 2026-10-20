/**
 * Outbound DM "seen" watch (workspace-backlog#11).
 *
 * Why this exists
 * ---------------
 * An agent that DMs another agent only learns the message was accepted, not
 * that the other side got it. The receiving agent's comm-bridge reacts `eyes`
 * on every inbound message it actually forwards to its agent (reactOnReceive
 * in comm-bridge.js); a message dropped by the receiver's dmPolicy, or by the
 * arrears gate, gets no reaction. cws-comm fans `message.reaction.added` /
 * `.removed` out to every member of the conversation as a `system` frame, so
 * the sender's bridge already receives that signal — the platform needs no
 * change. This module owns the waiting and the timeout; the agent hears
 * nothing unless the wait runs out.
 *
 * Flow
 * ----
 * send.js / comm.send are short-lived processes, and cws-comm does not echo a
 * sender's own message.created back to it, so they hand the sent message to
 * the long-lived bridge through a marker file (same pattern as the typing
 * `.done` markers). The bridge drains the markers and calls `watch()`.
 *
 *   - `watch()` resolves the conversation once (injected `resolveTarget`); only
 *     a DM whose peer is an agent is watched. Everything else is dropped
 *     silently — a human peer never auto-reacts, so watching it would only
 *     ever time out.
 *   - A target reaction from anyone but self settles the watch. `removed`
 *     counts too: the receiver removes `eyes` on reply or after 120s, so a
 *     removal proves it was there even when the `added` frame was missed.
 *   - Any message from the peer in that DM settles every watch on it.
 *   - Otherwise, at the deadline `onTimeout` is called once.
 *
 * The bridge only learns about a sent message when it drains the markers
 * (every 2s), and the receiver's `eyes` usually lands within ~100ms. So
 * qualifying reactions and peer messages are also remembered for a while when
 * nothing is watching them yet, and `watch()` checks that evidence first —
 * otherwise a fast `eyes` (and, by a fast reply, its removal) would be lost
 * before the watch exists and a delivered DM would be reported as unseen.
 *
 * Watches live in memory only. Reaction frames missed while the bridge is
 * down cannot be recovered, so the bridge discards markers left over from a
 * previous run instead of re-arming them (fail quiet, never a false alarm).
 * The same holds for a WebSocket drop: reconnect catch-up replays messages
 * but not reactions, so `onObservationLost()` drops that org's watches and a
 * message sent before `onObservationRestored()` is not watched at all.
 *
 * Pure apart from injected effects, so it is unit-testable without importing
 * the self-executing comm-bridge.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';

export const SENT_DIR = path.join(RUNTIME_DIR, 'dm-sent');
export const REACTION_EVENTS = new Set(['message.reaction.added', 'message.reaction.removed']);
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_REACTION_CODES = ['eyes'];
// Evidence that arrived before its watch: kept long enough to outlast the
// marker poll plus a slow conversation lookup, and capped so a busy org
// cannot grow it without bound.
export const EARLY_EVIDENCE_TTL_MS = 10 * 60_000;
export const EARLY_EVIDENCE_MAX = 500;

function idOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.length > 0 ? v : '';
}

/**
 * `config.message.dm_seen_watch` → effective settings.
 *   enabled          default true; false turns the watch off
 *   timeout_seconds  default 600
 *   reaction_codes   default ['eyes']; ['*'] accepts any reaction
 */
export function resolveDmSeenConfig(messageConfig) {
  const c = messageConfig?.dm_seen_watch || {};
  const secs = Number(c.timeout_seconds);
  const codes = Array.isArray(c.reaction_codes)
    ? c.reaction_codes.filter((x) => typeof x === 'string' && x.length > 0)
    : [];
  return {
    enabled: c.enabled !== false,
    timeoutMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : DEFAULT_TIMEOUT_MS,
    reactionCodes: codes.length > 0 ? codes : DEFAULT_REACTION_CODES,
  };
}

/** Message id to watch from a send result (the last chunk of a split text). */
export function sentMessageId(result) {
  const ids = Array.isArray(result?.message_ids) ? result.message_ids.filter(Boolean) : [];
  if (ids.length > 0) return idOf(ids[ids.length - 1]);
  return idOf(result?.id) || idOf(result?.message_id) || idOf(result?.message?.id);
}

/**
 * Sender side: hand a sent message to the bridge. Never throws.
 * `sentAt` is required and must be taken BEFORE the send request: the watch
 * compares it with reconnect times and peer replies, and the HTTP response can
 * arrive after both. Without it no marker is written (nothing is watched).
 */
export function writeSentMarker(dir, { conversationId, messageId, orgId = '', sentAt }) {
  const id = idOf(messageId);
  if (!id || !conversationId || !Number.isFinite(sentAt) || sentAt <= 0) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const body = JSON.stringify({ conversation_id: conversationId, message_id: id, org_id: orgId || '', sent_at: sentAt });
    const tmp = path.join(dir, `${safe}.tmp`);
    fs.writeFileSync(tmp, body);
    // rename so the poller never reads a half-written marker
    fs.renameSync(tmp, path.join(dir, `${safe}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Bridge side: read and delete every complete marker. */
export function drainSentMarkers(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(dir, f);
    try {
      const m = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (m?.conversation_id && m?.message_id) {
        out.push({
          conversationId: String(m.conversation_id),
          messageId: idOf(m.message_id),
          orgId: m.org_id || '',
          sentAt: Number(m.sent_at) || 0,
        });
      }
    } catch { /* unreadable marker — dropped below */ }
    try { fs.unlinkSync(fp); } catch {}
  }
  return out;
}

export function buildUnseenPrompt({ peerName, peerId, conversationId, messageId, waitedMs, reactionCodes }) {
  const mins = Math.max(1, Math.round(waitedMs / 60_000));
  const who = peerName ? `${peerName} (agent, member_id=${peerId || '?'})` : `agent member_id=${peerId || '?'}`;
  const codes = (reactionCodes || DEFAULT_REACTION_CODES).join('/');
  return (
    `[DM not seen] Your DM to ${who} has had no "${codes}" reaction for ${mins} min `
    + `(conversation_id=${conversationId}, message_id=${messageId}). `
    + `The other agent may not have received or seen it: its DM permission may not allow you, or it may be offline. `
    + `Do not keep resending. Report this to your owner and let them decide whether to request DM authorization or use another channel.`
  );
}

/**
 * @param {object} opts
 * @param {(entry) => Promise<{peerId?: string, peerName?: string, orgSlug?: string}|null>} opts.resolveTarget
 *   Non-null only for a DM whose peer is an agent. A throw counts as "not watched".
 * @param {(entry, target) => void} opts.onTimeout  Called at most once per watch.
 * @param {() => object} opts.getConfig             Current resolveDmSeenConfig() result.
 */
export function createDmSeenWatcher({
  resolveTarget,
  onTimeout,
  getConfig = () => resolveDmSeenConfig(),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
  warn = () => {},
} = {}) {
  // messageId -> { entry, target, timer, settled }
  const pending = new Map();
  // messageId -> { at, why }: a qualifying reaction nobody was watching yet
  const earlyReactions = new Map();
  // conversationId -> { at, senderId }: latest message from someone else
  const lastPeerMessage = new Map();
  // orgId -> { open, endedAt }: WebSocket observation gaps
  const gaps = new Map();

  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > EARLY_EVIDENCE_MAX) map.delete(map.keys().next().value);
  }

  function earlyEvidence(entry) {
    const r = earlyReactions.get(entry.messageId);
    if (r && now() - r.at <= EARLY_EVIDENCE_TTL_MS) return r.why;
    const m = lastPeerMessage.get(entry.conversationId);
    if (m && m.at >= entry.sentAt && now() - m.at <= EARLY_EVIDENCE_TTL_MS) return `peer message from ${m.senderId}`;
    return '';
  }

  // Sent before the org's socket first opened, while it was down, or before
  // it came back: reactions from that window are not replayed, so the watch
  // could only false-alarm.
  function inGap(orgId, sentAt) {
    const g = gaps.get(orgId || '');
    return !g || g.open || sentAt < g.endedAt;
  }

  function settle(messageId, why) {
    const w = pending.get(messageId);
    if (!w) return false;
    pending.delete(messageId);
    w.settled = true;
    if (w.timer !== undefined) clearTimer(w.timer);
    // Still qualifying: not known to be an agent DM, so nothing worth a line.
    if (w.target) {
      const secs = Math.round((now() - w.entry.sentAt) / 1000);
      log(`dm-seen-watch: seen msg=${messageId} conv=${w.entry.conversationId} (${why}) after ${secs}s`);
    }
    return true;
  }

  function expire(messageId) {
    const w = pending.get(messageId);
    if (!w) return;
    pending.delete(messageId);
    const waitedMs = now() - w.entry.sentAt;
    log(`dm-seen-watch: timeout msg=${messageId} conv=${w.entry.conversationId} peer=${w.target.peerId || '?'} after ${Math.round(waitedMs / 1000)}s — prompting agent`);
    try {
      onTimeout(w.entry, w.target, waitedMs);
    } catch (e) {
      warn(`dm-seen-watch: prompt for msg=${messageId} failed: ${e?.message || e}`);
    }
  }

  return {
    /** Start watching a sent message ({conversationId, messageId, orgId, sentAt}). */
    async watch(entry) {
      const cfg = getConfig();
      const messageId = idOf(entry?.messageId);
      if (!cfg.enabled || !messageId || !entry.conversationId || pending.has(messageId)) return false;
      const w = { entry: { ...entry, messageId, sentAt: entry.sentAt || now() }, target: null, timer: undefined, settled: false };
      // Registered before the lookup so a reaction arriving meanwhile still settles it.
      pending.set(messageId, w);
      const early = earlyEvidence(w.entry);
      if (early) {
        settle(messageId, `${early}, before the watch started`);
        return false;
      }
      let target = null;
      try {
        target = await resolveTarget(w.entry);
      } catch (e) {
        warn(`dm-seen-watch: conversation lookup for msg=${messageId} failed: ${e?.message || e} — not watching`);
      }
      if (w.settled) return false;
      if (!target) {
        pending.delete(messageId);
        return false;
      }
      if (inGap(target.orgId, w.entry.sentAt)) {
        pending.delete(messageId);
        log(`dm-seen-watch: not watching msg=${messageId} conv=${w.entry.conversationId} — sent during a connection gap`);
        return false;
      }
      w.target = target;
      const delay = Math.max(0, w.entry.sentAt + cfg.timeoutMs - now());
      w.timer = setTimer(() => expire(messageId), delay);
      w.timer?.unref?.();
      log(`dm-seen-watch: watching msg=${messageId} conv=${w.entry.conversationId} peer=${target.peerId || '?'} for ${Math.round(cfg.timeoutMs / 1000)}s`);
      return true;
    },

    /** Feed a reaction `system` frame payload ({event, conversation_id, data}). */
    onReaction(payload, selfMemberId) {
      if (!REACTION_EVENTS.has(String(payload?.event || '').toLowerCase())) return false;
      const data = payload?.data || {};
      const messageId = idOf(data.message_id);
      if (!messageId) return false;
      if (selfMemberId && String(data.reactor_id) === String(selfMemberId)) return false;
      const codes = getConfig().reactionCodes;
      if (!codes.includes('*') && !codes.includes(data.reaction_code)) return false;
      const why = `${payload.event} ${data.reaction_code} by ${data.reactor_id || '?'}`;
      if (!pending.has(messageId)) {
        remember(earlyReactions, messageId, { at: now(), why });
        return false;
      }
      return settle(messageId, why);
    },

    /** An inbound message: one from the peer settles every watch on that DM. */
    onPeerMessage(conversationId, senderId, selfMemberId) {
      if (!conversationId || !senderId) return 0;
      if (selfMemberId && String(senderId) === String(selfMemberId)) return 0;
      remember(lastPeerMessage, String(conversationId), { at: now(), senderId: String(senderId) });
      let n = 0;
      for (const [id, w] of [...pending]) {
        if (w.entry.conversationId === String(conversationId) && settle(id, `peer message from ${senderId}`)) n++;
      }
      return n;
    },

    /**
     * The org's socket closed: reactions until it is back are lost for good.
     * Drop its watches silently (and any not yet resolved to an org).
     */
    onObservationLost(orgId) {
      const key = orgId || '';
      gaps.set(key, { open: true, endedAt: 0 });
      let n = 0;
      for (const [id, w] of [...pending]) {
        if (w.target && (w.target.orgId || '') !== key) continue;
        pending.delete(id);
        w.settled = true;
        if (w.timer !== undefined) clearTimer(w.timer);
        n++;
      }
      if (n > 0) log(`dm-seen-watch: connection lost for org=${key || '?'} — dropped ${n} watch(es) without prompting`);
      return n;
    },

    /** The org's socket is back; only messages sent from now on are watched. */
    onObservationRestored(orgId) {
      gaps.set(orgId || '', { open: false, endedAt: now() });
    },

    stop() {
      for (const w of pending.values()) if (w.timer !== undefined) clearTimer(w.timer);
      pending.clear();
    },

    pendingCount() { return pending.size; },
  };
}
