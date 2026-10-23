/**
 * WebSocket client for cws-comm.
 *
 * Aligned with cws-comm api-design.md §3-§4:
 *   - Auth:       Bearer token in connect headers, plus X-Workspace-Id
 *   - Heartbeat:  JSON ping/pong text frames (NOT WS-level ping/pong);
 *                 server initiates ping, client replies pong within
 *                 cws-comm-configured pongTimeout (default 10s).
 *                 If we receive no frame at all for >
 *                 heartbeatIntervalMs * (maxMissedPongs+1) + grace
 *                 we proactively terminate to force a reconnect.
 *   - Reconnect:  exponential backoff 1s → 2s → 4s → ... capped at
 *                 reconnect_max_delay (default 30s).
 *   - Close codes (§4.5):
 *       1000 / 1001  — normal close, reconnect
 *       4001         — heartbeat timeout, reconnect
 *       4002         — auth failed, STOP (caller alerts)
 *       4003         — session expired, caller should clear session
 *                      then reconnect with api_key
 *       4004         — rate limited, reconnect with longer delay
 *       4005         — workspace suspended, STOP
 *       4006         — duplicate connection, STOP
 *
 * Callbacks (all optional):
 *   onOpen(client)
 *   onMessage(frame)                — frame is parsed JSON, includes ping/pong
 *   onClose(code, reason, willReconnect)
 *   onFatal(code, reason)           — invoked instead of onClose when a
 *                                     terminal close code (4002/4005/4006) hits
 *
 * The client auto-replies to `{type:'ping'}` frames with `{type:'pong'}` —
 * the message handler receives the ping but does NOT need to reply.
 */

import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { cfAccessHeaders } from './cf-access.js';

const RECONNECT_BASE_MS = 1000;
const FRAME_GRACE_MS = 5000;
const TERMINAL_CLOSE_CODES = new Set([4002, 4005, 4006]);
const RATE_LIMITED_CLOSE_CODES = new Set([4004]);
// trySend() drops instead of queueing once this much is already buffered.
const TRY_SEND_MAX_BUFFERED = 1024 * 1024;

export class WsClient {
  constructor({
    url,
    urlProvider,            // optional async () => string; if present, called
                            // before each connect to mint a fresh URL (e.g.
                            // to fetch a one-shot ticket and append it).
                            // If it throws, the connect is retried via the
                            // normal backoff loop.
    token,
    workspaceId,
    deviceId,
    clientVersion,
    reconnectMaxMs = 30000,
    heartbeatIntervalMs = 30000,
    // Client-initiated WS-level ping cadence. The server-side path does NOT
    // guarantee that server pings reach us (on prod they don't traverse the
    // path at all), so the client must feed the frame-watchdog itself by
    // sending its own periodic ping; the elicited pong advances lastFrameAt.
    // Must stay comfortably below the watchdog window
    // (heartbeatIntervalMs * 2 + FRAME_GRACE_MS = 65s at defaults).
    pingIntervalMs = 20000,
    // Upgrade/handshake budget handed to the `ws` lib. Without it the lib waits
    // indefinitely, so a dial that is accepted at TCP level but never answered
    // (black-holed hop, silent proxy) leaves the client in CONNECTING forever —
    // no open, no error, no close, therefore no reconnect and no log line. That
    // is the permanent-offline wedge this exists to prevent.
    handshakeTimeoutMs = 15000,
    // Belt to the handshakeTimeout brace: an absolute deadline for reaching
    // `open`, covering hangs the lib's own timeout does not surface. Must stay
    // above handshakeTimeoutMs so the lib reports first when it can.
    dialTimeoutMs = 25000,
    onOpen,
    onMessage,
    onClose,
    onFatal,
    // Optional factory for the underlying WebSocket, for testability. Defaults
    // to the real `ws` implementation.
    wsFactory,
  }) {
    this.url = url;
    this.urlProvider = urlProvider || null;
    this.token = token;
    this.workspaceId   = workspaceId   || '';
    this.deviceId      = deviceId      || '';
    this.clientVersion = clientVersion || '';
    this.reconnectMaxMs = reconnectMaxMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.pingIntervalMs = pingIntervalMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.dialTimeoutMs = dialTimeoutMs;
    this.onOpen    = onOpen    || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onClose   = onClose   || (() => {});
    this.onFatal   = onFatal   || (() => {});
    this.wsFactory = wsFactory || ((u, opts) => new WebSocket(u, opts));

    this.ws = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.frameWatchdog = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.dialTimer = null;
    this.lastFrameAt = 0;
    // Connection phase, for the supervisor: 'idle' | 'connecting' | 'open' |
    // 'closed'. `stateSince` lets a watchdog detect a phase that has not
    // advanced — the only way to notice a stalled dial, since a stuck socket is
    // CONNECTING (not CLOSED) and so looks nothing like "disconnected".
    this.state = 'idle';
    this.stateSince = Date.now();
    // True from the moment _connect() is entered until a socket exists (or the
    // attempt has bailed). The socket-based single-flight guard cannot cover the
    // pre-socket phase: urlProvider() does hydration + a ws-ticket fetch, and
    // while that promise is pending there is no socket and the state is not yet
    // 'connecting', so nothing else can tell an attempt is already under way.
    this.dialing = false;
    // Type / time of the last frame this client sent (see _noteSent).
    this.lastSentType = null;
    this.lastSentAt = 0;
  }

  _setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.stateSince = Date.now();
  }

  /** ms spent in the current connection phase. */
  stalledMs() { return Date.now() - this.stateSince; }

  start() {
    this.stopped = false;
    this._connect().catch(err => console.error('[ws] connect threw:', err.message));
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    if (this.ws) {
      try { this.ws.close(1000, 'client stop'); } catch {}
      this.ws = null;
    }
  }

  /**
   * Update the auth token for the next connection (e.g. after handshake
   * yields a session_token, or after 4003 we fall back to api_key).
   */
  setToken(token) { this.token = token; }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    this._noteSent(payload);
  }

  /**
   * Best-effort send for lossy frames (agent_activity): never throws, never
   * buffers, never retries. Returns false — and the frame is simply gone —
   * when the socket is not open or more than 1 MiB is already queued locally.
   * send() keeps its throwing semantics (the pong reply relies on it).
   */
  trySend(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if ((this.ws.bufferedAmount || 0) > TRY_SEND_MAX_BUFFERED) return false;
    try {
      this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    } catch {
      return false;
    }
    this._noteSent(frame);
    return true;
  }

  // The server's error frames carry no correlation id; the type of the last
  // frame we sent is what lets a caller attribute UNKNOWN_FRAME_TYPE.
  _noteSent(payload) {
    let type = null;
    if (payload && typeof payload === 'object') type = payload.type ?? null;
    this.lastSentType = type;
    this.lastSentAt = Date.now();
  }

  isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  /**
   * Force the current socket closed to trigger the normal reconnect path
   * (close handler → _scheduleReconnect → _connect → onOpen → /sync catch-up).
   * Uses the same `terminate()` mechanism the frame-watchdog uses, so the
   * close handler runs and the exponential backoff loop supplies the retry
   * cadence. Safe no-op when stopped or when there is no live socket.
   *
   * Callers use this to recover from an inbound message whose content could
   * not be fetched: dropping the socket lets the reconnect's /sync sweep
   * re-pull the missed message in seq order.
   */
  forceReconnect(reason = 'forced') {
    if (this.stopped) return false;
    if (!this.ws) return false;
    console.warn(`[ws] force reconnect requested (${reason})`);
    try { this.ws.terminate(); } catch {}
    return true;
  }

  async _connect() {
    if (this.stopped) return;
    // Single-flight, phase 1 — BEFORE the ws-ticket is fetched. urlProvider()
    // awaits hydration + a ticket fetch, and during that await there is no
    // socket and the state is not yet 'connecting', so the socket-based guard
    // below is blind to the attempt: the stall watchdog's ensureConnecting()
    // would schedule a second _connect(), burning a second single-use ticket
    // and — once both providers resolve — terminating the socket that was about
    // to succeed. That is the very duplicate-dial the guard exists to prevent,
    // just moved one step earlier in the sequence.
    if (this.dialing) {
      console.warn('[ws] connect requested while a dial is already in flight (pre-socket) — ignoring');
      return;
    }
    // Single-flight, phase 2 — socket created but not yet open. The server
    // treats a second registration as the device being replaced and terminates
    // the first, so a stray parallel dial does not just waste a socket — it can
    // kill the connection that was about to succeed.
    if (this.state === 'connecting' && this.ws) {
      console.warn('[ws] connect requested while a dial is already in flight — ignoring');
      return;
    }
    // Marked in flight for the whole of _connect, and cleared in the finally at
    // the end: by then either a socket exists (the phase-2 guard takes over) or
    // the attempt has bailed. Deliberately inlined rather than delegating to a
    // helper — `await someHelper()` would defer socket creation by a microtask,
    // and callers (start(), the tests) rely on a dial with no urlProvider
    // creating its socket synchronously.
    this.dialing = true;
    try {
      // Replacing a socket from a previous attempt: kill it first so an orphan
      // cannot complete its handshake later and become that second session.
      if (this.ws) {
        try { this.ws.terminate(); } catch { /* already gone */ }
        this.ws = null;
      }
      let url = this.url;
      let urlMintedAt = null;
      if (this.urlProvider) {
        try {
          url = await this.urlProvider();
          urlMintedAt = Date.now();
        } catch (err) {
          console.error('[ws] urlProvider failed:', err.message);
          // Respect Retry-After hints from cws-core when fetching ws-ticket
          const retryHint = Number(err.retryAfterMs) || 0;
          if (!this.stopped) this._scheduleReconnect(false, retryHint);
          return;
        }
      }
      // Re-check after the await: a stop() / disable that landed while the ticket
      // fetch was pending must not be carried on into creating a socket — that
      // would revive a client the caller deliberately shut down.
      if (this.stopped) {
        console.warn('[ws] stopped while resolving the connect URL — abandoning this dial');
        return;
      }
      if (!url) {
        console.error('[ws] no URL to connect to');
        if (!this.stopped) this._scheduleReconnect(false);
        return;
      }

      const headers = { ...cfAccessHeaders() };
      if (this.token)         headers.Authorization      = `Bearer ${this.token}`;
      if (this.workspaceId)   headers['X-Workspace-Id']  = this.workspaceId;
      if (this.deviceId)      headers['X-Device-Id']     = this.deviceId;
      if (this.clientVersion) headers['X-Client-Version'] = this.clientVersion;

      // A ws-ticket is single-use and short-lived, so how long the URL sat between
      // being minted and being dialed is diagnostic when a connect fails.
      const urlAgeMs = urlMintedAt === null ? null : Date.now() - urlMintedAt;
      console.log(`[ws] connecting${urlAgeMs === null ? '' : ` (url age ${urlAgeMs}ms)`}`);

      this._setState('connecting');
      this.ws = this.wsFactory(url, { headers, handshakeTimeout: this.handshakeTimeoutMs });
      this.lastFrameAt = Date.now();

      // Absolute deadline for reaching `open`. Without this, a dial that never
      // answers and never errors parks the client in CONNECTING with no timer
      // left running — the exact "log stops at connecting…, agent stays offline
      // until someone restarts it" wedge.
      // Handlers first — an event must never be able to fire before they exist.
      this._attachHandlers();

      // Then the deadline, and only while the socket is actually still
      // handshaking: an implementation that reports OPEN synchronously has
      // nothing left to wait for, and a deadline would fight a connection that
      // already succeeded.
      if (this.ws?.readyState === WebSocket.CONNECTING) this._armDialDeadline();
    } finally {
      this.dialing = false;
    }
  }

  _armDialDeadline() {
    this.dialTimer = setTimeout(() => {
      this.dialTimer = null;
      if (this.stopped || this.state === 'open') return;
      console.warn(`[ws] dial did not reach open within ${this.dialTimeoutMs}ms — terminating and retrying`);
      try { this.ws?.terminate(); } catch { /* already gone */ }
      // We just killed it ourselves: drop the reference and leave 'connecting'
      // so the retry below is not mistaken for a concurrent dial.
      this.ws = null;
      this._setState('closed');
      // Schedule directly: a socket this stuck may never emit 'close'.
      // _scheduleReconnect is idempotent, so a later 'close' is a no-op.
      this._scheduleReconnect(false);
    }, this.dialTimeoutMs);
    this.dialTimer.unref?.();
  }

  _attachHandlers() {
    this.ws.on('open', () => {
      this._clearDialTimer();
      this._setState('open');
      this.reconnectAttempt = 0;
      this._startFrameWatchdog();
      this._startKeepalivePing();
      this.onOpen(this);
    });

    this.ws.on('message', (raw) => {
      this.lastFrameAt = Date.now();
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }

      // Auto-reply to JSON ping with JSON pong (cws-comm §4.3).
      if (frame.type === 'ping') {
        try { this.send({ type: 'pong', timestamp: Date.now() }); } catch {}
      }
      this.onMessage(frame);
    });

    // WS protocol-level control frames. The npm `ws` lib auto-replies to
    // server Pings with Pongs (no action needed here), but it does NOT fire
    // the 'message' event for control frames — so without these listeners
    // `lastFrameAt` would stay at the open timestamp even while heartbeats
    // are flowing, and the frame watchdog would kill a perfectly healthy
    // connection. cws-comm uses WS-level Ping/Pong (see
    // cws-comm internal/transport/ws/conn.go RunPingLoop), so this matters.
    this.ws.on('ping', () => {
      this.lastFrameAt = Date.now();
      // One-line debug trace so we can verify server-side ping cadence in
      // pm2 logs. Cheap (default cws-comm PingInterval is 30s).
      console.log('[ws] ping received');
    });
    this.ws.on('pong', () => {
      this.lastFrameAt = Date.now();
    });

    this.ws.on('close', (code, reasonBuf) => {
      this._clearTimers();
      this._clearDialTimer();
      this._setState('closed');
      const reason = reasonBuf?.toString?.() || '';
      const terminal = TERMINAL_CLOSE_CODES.has(code);
      const rateLimited = RATE_LIMITED_CLOSE_CODES.has(code);

      if (terminal) {
        this.stopped = true;
        this.onFatal(code, reason);
        return;
      }
      const willReconnect = !this.stopped;
      this.onClose(code, reason, willReconnect);
      if (willReconnect) this._scheduleReconnect(rateLimited);
    });

    this.ws.on('error', (err) => {
      // 'close' fires after error; just log
      console.error('[ws] error:', err.message);
    });
  }

  /**
   * Supervisor entry point: make sure a connection attempt is in flight.
   *
   * Distinct from forceReconnect(), which by contract only kicks a socket that
   * exists (and is a deliberate no-op otherwise). A stalled dial is not
   * "disconnected" — the socket sits in CONNECTING — so a watchdog cannot
   * detect it by liveness and must ask by phase instead.
   *
   * Returns true if it started or scheduled an attempt, false if nothing was
   * needed (already open, already scheduled, or deliberately stopped).
   */
  ensureConnecting(reason = 'supervisor') {
    if (this.stopped) return false;
    if (this.state === 'open') return false;
    // A dial whose ws-ticket fetch is still pending has no socket and no queued
    // timer, so without this check the supervisor reads it as "nothing in
    // flight" and starts a competing attempt — which is exactly what it must
    // never do on one credential set.
    if (this.dialing) return false;
    if (this.reconnectTimer) return false;   // an attempt is already queued
    if (this.ws) return this.forceReconnect(reason);
    console.warn(`[ws] ${reason}: no socket and no pending attempt — scheduling connect`);
    this._scheduleReconnect(false);
    return true;
  }

  _clearDialTimer() {
    if (this.dialTimer) { clearTimeout(this.dialTimer); this.dialTimer = null; }
  }

  _scheduleReconnect(rateLimited) {
    // Idempotent: the dial deadline and a late 'close' can both ask for a retry
    // for the same dead socket, and two pending timers would double the
    // in-flight connects — a second socket on the same credentials is exactly
    // what causes duplicate-session trouble.
    if (this.reconnectTimer) return;
    const base = rateLimited ? Math.max(RECONNECT_BASE_MS * 8, 5000) : RECONNECT_BASE_MS;
    const delay = Math.min(base * (2 ** this.reconnectAttempt), this.reconnectMaxMs);
    this.reconnectAttempt += 1;
    console.log(`[ws] reconnecting in ${delay}ms (attempt #${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this._connect();
    }, delay);
  }

  /**
   * If we receive no frames at all for more than the watchdog window,
   * the connection is dead — terminate to trigger reconnect. The window
   * is sized to allow for one missed ping (server pings every interval,
   * client must pong; if server stops pinging it's down).
   */
  _startFrameWatchdog() {
    this._clearTimers();
    const watchdogMs = (this.heartbeatIntervalMs * 2) + FRAME_GRACE_MS;
    this.frameWatchdog = setInterval(() => {
      if (Date.now() - this.lastFrameAt > watchdogMs) {
        console.warn('[ws] no frames received within watchdog window, terminating');
        try { this.ws.terminate(); } catch {}
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * Send our own WS-level ping on a fixed cadence so the frame-watchdog is fed
   * regardless of whether SERVER pings ever reach us. On prod, server pings do
   * not traverse the path, so a quiet org would otherwise starve the watchdog
   * (heartbeatIntervalMs*2 + grace) and churn with close code 1006 every few
   * minutes. An RFC-compliant server — or the nearest terminating proxy —
   * auto-replies with a pong, and the existing `on('pong')` handler advances
   * lastFrameAt. This also keeps the pipe warm through intermediaries (the
   * standard IM keepalive direction). Purely additive: the server-side ping
   * path and the watchdog are unchanged.
   */
  _startKeepalivePing() {
    if (this.pingTimer) return;   // guard against double-arming
    this.pingTimer = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
      } catch {}
    }, this.pingIntervalMs);
  }

  _clearTimers() {
    if (this.frameWatchdog) { clearInterval(this.frameWatchdog); this.frameWatchdog = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this._clearDialTimer();
  }
}

/**
 * Message deduplication by message_id, retaining the most recent N ids.
 *
 * Returns a function that takes a message id and returns true if it was already
 * seen (within the retained window), false otherwise (and records it).
 *
 * Retention is COUNT-based (keep the most recent `maxEntries` ids), NOT
 * time-based. Rationale: a reconnect/restart catch-up can replay up to
 * SYNC_MAX_EVENTS (2000) events regardless of how long the bot was offline, so
 * a fixed-size recent-id window guarantees those replays are deduped. A short
 * TTL (the previous behavior) let ids age out mid-catch-up and leaked
 * duplicates after a >TTL outage.
 *
 * `opts.persistPath` (optional): back the seen-id window with a JSON file so it
 * survives a process restart (debounced atomic write; loaded + capped on init).
 * Best-effort — fs errors are swallowed and the deduper degrades to in-memory.
 * `opts.maxEntries` (default 5000): retained-id count; must exceed
 * SYNC_MAX_EVENTS so a full catch-up sweep is always covered.
 */
export function createDeduper(optsOrLegacyTtl = {}, legacyOpts) {
  // Backward compat: old call-sites passed (ttlMs, opts); new ones pass (opts).
  const opts = typeof optsOrLegacyTtl === 'object' ? optsOrLegacyTtl : (legacyOpts || {});
  const { persistPath = null, maxEntries = 5000 } = opts;
  const seen = new Map();   // id -> first-seen ts(ms); Map insertion order = age

  function evictOverflow() {
    while (seen.size > maxEntries) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }

  if (persistPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(persistPath, 'utf-8'));
      for (const [k, t] of Object.entries(raw)) {
        if (typeof t === 'number') seen.set(k, t);
      }
      evictOverflow();   // keep only the most recent maxEntries on load
    } catch { /* missing/corrupt → start empty */ }
  }

  let dirty = false;
  let flushTimer = null;
  function flush() {
    flushTimer = null;
    if (!persistPath || !dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const tmp = `${persistPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(seen)));
      fs.renameSync(tmp, persistPath);
    } catch { /* best-effort */ }
  }
  function scheduleFlush() {
    if (!persistPath || flushTimer) return;
    flushTimer = setTimeout(flush, 1000);
    flushTimer.unref?.();
  }

  const deduper = (id) => {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.set(id, Date.now());
    evictOverflow();
    dirty = true; scheduleFlush();
    return false;
  };

  // Drop a previously-recorded id so it is NOT treated as a duplicate the next
  // time it arrives. Used when an inbound message was recorded as "seen" but
  // then could not be fully processed (e.g. its content fetch failed): the
  // message must be re-processable when the next /sync catch-up re-pulls it,
  // otherwise the dedupe would silently suppress the retry.
  deduper.forget = (id) => {
    if (!id || !seen.has(id)) return false;
    seen.delete(id);
    dirty = true; scheduleFlush();
    return true;
  };

  return deduper;
}
