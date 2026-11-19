/**
 * OpenMax Browser one-click connect (channel_type `browser-remote`).
 *
 * cws-connect pushes a channel command over cws-comm with channel_type
 * `browser-remote`, binding_id = the browser connection_id and a request_id:
 *
 *   prepare — make sure the browser-remote component is installed and running,
 *             replace any Key already minted for this connection, mint a new
 *             one (`key.js new --connection <id> --ttl-days 30
 *             --single-browser --json`) and report relay URL + Key to
 *             POST /connect/browser-connections/{id}/prepare-result.
 *   revoke  — revoke every Key minted for this connection and ack each with
 *             POST /connect/browser-connections/{id}/revoke-ack {key_id}.
 *
 * A reconcile pass (startup + interval) lists the Agent's active connections
 * (GET /connect/agent-browser-connections) and revokes local Workspace Keys
 * (those with a connectionId) whose connection is no longer active. Keys made
 * by hand (no connectionId) are never touched.
 *
 * Secret handling: the Key is only ever held in memory and sent in the
 * prepare-result body. Error strings logged or reported here are scrubbed of
 * it, and client.js's RPC log redacts the body's `key` field (redact.js). A
 * prepare-result that cannot be delivered is queued on disk WITHOUT the Key or
 * relay URL; the resend reuses the undelivered Key while it is still live in
 * this process (else mints a fresh one, revoking the old) unless cws-connect
 * already shows the connection as ready. A non-retryable 4xx is final: the
 * Key is revoked and nothing is queued.
 *
 * Deps are injected so the flow is unit-testable (browser-remote-connector.test.js).
 */

import fs from 'fs';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { readPm2Statuses } from './channel-connector.js';
import { RUNTIME_DIR } from './session.js';

const HOME = process.env.HOME;
const promisifiedExecFile = promisify(execFileCb);
const realExecFile = (file, args, opts) =>
  promisifiedExecFile(file, args, { timeout: 20_000, ...(opts || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const BROWSER_REMOTE_CHANNEL_TYPE = 'browser-remote';
export const BROWSER_REMOTE_COMPONENT = 'browser-remote';
export const BROWSER_REMOTE_PM2 = 'zylos-browser-remote';
export const BROWSER_KEY_TTL_DAYS = 30;
export const BROWSER_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
// A Key younger than this is never reconciled away: its prepare-result may
// still be in flight (the connection is `preparing`, which the active list
// does not include).
export const BROWSER_RECONCILE_GRACE_MS = 30 * 60 * 1000;
export const BROWSER_KEY_RECORD_FILE = path.join(RUNTIME_DIR, 'browser-remote-keys.json');

const INSTALL_TIMEOUT_MS = 180_000;
const QUERY_TIMEOUT_MS = 20_000;
const VERIFY_TIMEOUT_MS = 60_000;
const VERIFY_POLL_MS = 2_000;
const TOO_OLD = 'browser-remote is too old for OpenMax Browser: upgrade it to the release '
  + 'with connection keys (key.js --json / --connection, zylos-browser-remote PR #25)';

export const isBrowserRemoteCommand = (data) =>
  String(data?.channel_type || '').toLowerCase() === BROWSER_REMOTE_CHANNEL_TYPE;

/** https://host → wss://host/browser-remote/ext (http → ws). */
export function relayUrlFromBase(baseUrl) {
  const u = new URL(String(baseUrl));
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  else throw new Error(`unsupported base URL scheme ${u.protocol}`);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/browser-remote/ext`;
  u.search = ''; u.hash = '';
  return u.toString();
}

// 4xx other than auth / timeout / rate limit: the request itself is rejected,
// so resending it (and re-minting a Key for it) can never succeed. 401 stays
// retryable: client.js throttles token refresh, so it can be transient.
const isFinalHttpError = (e) => e?.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);

function isEventForMe(data, selfMemberId) {
  if (data.agent_member_id) return data.agent_member_id === selfMemberId;
  if (Array.isArray(data.agent_member_ids)) return data.agent_member_ids.includes(selfMemberId);
  return true;
}

/**
 * @param {object} deps
 * @param {(orgId, path, query?) => Promise<any>} deps.getForOrg
 * @param {(orgId, path, body, opts?) => Promise<any>} deps.postForOrg
 * @param {(p) => string} deps.apiPath
 * @param {(orgId) => Promise<string>} deps.resolveRelayUrl  throws when the Agent has no public domain
 * @param {(key) => boolean} deps.dedupe
 * @param {(entry) => void} [deps.persistUndeliveredResult]  queue a key-less prepare-result
 * @param {() => Array} [deps.readQueued]  entries currently queued (reconcile skips their connections)
 */
export function createBrowserRemoteConnector({
  getForOrg,
  postForOrg,
  apiPath,
  resolveRelayUrl,
  dedupe = () => false,
  persistUndeliveredResult,
  readQueued = () => [],
  execFile = realExecFile,
  nodeBin = process.execPath,
  home = HOME,
  fsDep = fs,
  keyRecordFile = BROWSER_KEY_RECORD_FILE,
  now = Date.now,
  reportAttempts = 3,
  reportRetryDelayMs = 2000,
  reportSleep = sleep,
  verifyTimeoutMs = VERIFY_TIMEOUT_MS,
  verifyPollMs = VERIFY_POLL_MS,
  reconcileGraceMs = BROWSER_RECONCILE_GRACE_MS,
  callbackTimeoutMs = 20_000,
  log = () => {},
  warn = () => {},
} = {}) {
  const skillDir = path.join(home, 'zylos/.claude/skills', BROWSER_REMOTE_COMPONENT);
  const keyScript = path.join(skillDir, 'scripts/key.js');

  // Every Key this process has seen in plaintext; scrub() masks them out of
  // anything that is logged or reported.
  const secrets = new Set();
  // connectionId → { key, keyId } minted by this process and not yet known to
  // be delivered: a resend reuses it instead of minting a Key per attempt.
  const minted = new Map();
  const forget = (connectionId) => {
    const m = minted.get(connectionId);
    if (m) { secrets.delete(m.key); minted.delete(connectionId); }
  };
  const scrub = (msg) => {
    let s = String(msg ?? '').replace(/\s+/g, ' ').trim();
    for (const k of secrets) if (k && k.length >= 6) s = s.split(k).join('***');
    return s.length > 300 ? `${s.slice(0, 297)}...` : s;
  };

  // Serialize work per connection so a prepare and a revoke (or a resend) for
  // the same connection never interleave their list → revoke → new steps.
  const chains = new Map();
  const serial = (connectionId, fn) => {
    const prev = chains.get(connectionId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    chains.set(connectionId, tail);
    tail.then(() => { if (chains.get(connectionId) === tail) chains.delete(connectionId); });
    return next;
  };

  // --- connectionId → last keyId record (non-secret; for revoke-ack) -------
  const readRecord = () => {
    try {
      const v = JSON.parse(fsDep.readFileSync(keyRecordFile, 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  };
  const writeRecord = (rec) => {
    try {
      fsDep.mkdirSync(path.dirname(keyRecordFile), { recursive: true });
      fsDep.writeFileSync(keyRecordFile, JSON.stringify(rec, null, 2), { mode: 0o600 });
    } catch (e) { warn(`[browser-remote] could not write key record: ${e.message}`); }
  };
  const remember = (connectionId, keyId) => {
    const rec = readRecord();
    if (keyId) rec[connectionId] = keyId; else delete rec[connectionId];
    writeRecord(rec);
  };

  // --- key.js ---------------------------------------------------------------
  async function keyCmd(args) {
    let stdout;
    try {
      ({ stdout } = await execFile(nodeBin, [keyScript, ...args, '--json'], { timeout: QUERY_TIMEOUT_MS }));
    } catch (e) {
      // key.js --json exits 2 with {"ok":false,"error"} on stdout for usage errors.
      let parsed = null;
      try { parsed = JSON.parse(String(e.stdout || '').trim().split('\n').pop()); } catch { /* not JSON */ }
      // Never tooOld here: an old key.js ignores --json and exits 0 with text
      // (handled below). A non-zero exit without JSON is a real failure (crash,
      // corrupt keys.json, timeout); an upgrade would not fix it and would
      // restart the relay, dropping every connected browser.
      throw new Error(parsed?.error ? `key.js ${args[0]}: ${parsed.error}` : `key.js ${args[0]} failed: ${scrub(e.message)}`);
    }
    let out;
    try { out = JSON.parse(String(stdout).trim().split('\n').pop()); } catch {
      const err = new Error(TOO_OLD);
      err.tooOld = true;
      throw err;
    }
    if (!out || out.ok !== true) throw new Error(`key.js ${args[0]}: ${scrub(out?.error || 'not ok')}`);
    return out;
  }

  async function listKeys() {
    const out = await keyCmd(['list']);
    if (!Array.isArray(out.keys)) {
      const err = new Error(TOO_OLD);
      err.tooOld = true;
      throw err;
    }
    return out.keys;
  }

  async function revokeKey(keyId) {
    await keyCmd(['revoke', keyId]);
  }

  async function mintKey(connectionId, { reuse = false } = {}) {
    const existing = (await listKeys()).filter((k) => k?.connectionId === connectionId);
    const prev = minted.get(connectionId);
    if (reuse && prev && existing.length === 1 && existing[0].keyId === prev.keyId) return prev;
    forget(connectionId);
    // Retries must not leak Keys: whatever exists for this connection goes first.
    for (const k of existing) {
      await revokeKey(k.keyId);
      log(`[browser-remote] revoked previous key ${k.keyId} for connection ${connectionId}`);
    }
    const out = await keyCmd(['new', '--label', `openmax:${connectionId}`, '--connection', connectionId,
      '--ttl-days', String(BROWSER_KEY_TTL_DAYS), '--single-browser']);
    if (typeof out.key !== 'string' || !out.key || !out.keyId) throw new Error('key.js new returned no key');
    secrets.add(out.key);
    if (out.connectionId !== connectionId) {
      // An old key.js that ignored --connection: do not hand out an untracked Key.
      await revokeKey(out.keyId).catch(() => {});
      throw new Error(TOO_OLD);
    }
    remember(connectionId, out.keyId);
    const m = { key: out.key, keyId: out.keyId };
    minted.set(connectionId, m);
    return m;
  }

  // --- component ------------------------------------------------------------
  async function isInstalled() {
    try {
      const { stdout } = await execFile('zylos', ['info', BROWSER_REMOTE_COMPONENT, '--json'], { timeout: QUERY_TIMEOUT_MS });
      return JSON.parse(String(stdout))?.name === BROWSER_REMOTE_COMPONENT;
    } catch { return false; }
  }

  async function supportsConnectionKeys() {
    try { await listKeys(); return true; } catch (e) {
      if (e.tooOld) return false;
      throw e;
    }
  }

  // Install when missing; upgrade only when the installed copy lacks
  // connection keys (an upgrade restarts the relay and drops every connected
  // browser, so it is not done on every prepare).
  async function ensureComponent() {
    if (!(await isInstalled())) {
      log('[browser-remote] component not installed → zylos add');
      await execFile('zylos', ['add', BROWSER_REMOTE_COMPONENT, '--yes'], { timeout: INSTALL_TIMEOUT_MS });
    } else if (!(await supportsConnectionKeys())) {
      log('[browser-remote] installed copy lacks connection keys → zylos upgrade');
      await execFile('zylos', ['upgrade', BROWSER_REMOTE_COMPONENT, '--yes'], { timeout: INSTALL_TIMEOUT_MS });
    } else {
      return;
    }
    if (!(await supportsConnectionKeys())) throw new Error(TOO_OLD);
  }

  async function ensureRunning() {
    const status = await readPm2Statuses(execFile);
    if (status?.get(BROWSER_REMOTE_PM2) === true) return;
    log(`[browser-remote] ${BROWSER_REMOTE_PM2} not online → starting`);
    try {
      await execFile('pm2', ['restart', BROWSER_REMOTE_PM2, '--update-env'], { timeout: QUERY_TIMEOUT_MS });
    } catch {
      await execFile('pm2', ['start', path.join(skillDir, 'ecosystem.config.cjs'), '--update-env'],
        { timeout: QUERY_TIMEOUT_MS }).catch((e) => warn(`[browser-remote] pm2 start failed: ${e.message}`));
    }
    const deadline = now() + verifyTimeoutMs;
    for (;;) {
      const s = await readPm2Statuses(execFile);
      if (s?.get(BROWSER_REMOTE_PM2) === true) return;
      if (now() >= deadline) throw new Error(`${BROWSER_REMOTE_PM2} did not come online`);
      await reportSleep(verifyPollMs);
    }
  }

  // --- callbacks ------------------------------------------------------------
  const postPrepareResult = (orgId, connectionId, body) => postForOrg(
    orgId, apiPath(`/connect/browser-connections/${connectionId}/prepare-result`), body,
    { timeoutMs: callbackTimeoutMs },
  );

  async function reportPrepare(meta, result) {
    const body = {
      request_id: meta.requestId || '',
      ok: !!result.ok,
      ...(result.ok
        ? { relay_url: result.relayUrl, key_id: result.keyId, key: result.key }
        : { error: scrub(result.error) }),
    };
    for (let attempt = 1; attempt <= reportAttempts; attempt++) {
      try {
        await postPrepareResult(meta.orgId, meta.bindingId, body);
        log(`[${meta.slug}] browser prepare-result delivered connection=${meta.bindingId} ok=${body.ok}`
          + (body.ok ? ` key_id=${body.key_id}` : ''));
        forget(meta.bindingId);
        return true;
      } catch (e) {
        if (isFinalHttpError(e)) {
          warn(`[${meta.slug}] browser prepare-result rejected connection=${meta.bindingId}`
            + ` (HTTP ${e.status}): ${scrub(e.message)} — not retried`);
          if (body.ok) await discardKey(meta.bindingId, body.key_id);
          return false;
        }
        const last = attempt === reportAttempts;
        warn(`[${meta.slug}] browser prepare-result failed connection=${meta.bindingId}`
          + ` (attempt ${attempt}/${reportAttempts}): ${scrub(e.message)}${last ? ' — queuing for resend' : ''}`);
        if (!last) await reportSleep(reportRetryDelayMs * attempt);
      }
    }
    // Queue WITHOUT the Key / relay URL: the resend mints a fresh Key.
    try {
      await persistUndeliveredResult?.({
        kind: 'browser-prepare',
        slug: meta.slug,
        orgId: meta.orgId,
        bindingId: meta.bindingId,
        requestId: meta.requestId,
        channelType: BROWSER_REMOTE_CHANNEL_TYPE,
        status: body.ok ? 'ok' : 'error',
        ...(body.ok ? {} : { detail: body.error }),
      });
    } catch (e) { warn(`[${meta.slug}] could not queue browser prepare-result: ${e.message}`); }
    return false;
  }

  // The Key was rejected for good (final 4xx): revoke it rather than leave a
  // live Key nobody received.
  async function discardKey(connectionId, keyId) {
    forget(connectionId);
    if (keyId) await revokeKey(keyId).catch((e) => warn(`[browser-remote] could not revoke ${keyId}: ${scrub(e.message)}`));
  }

  async function produce(meta, { reuse = false } = {}) {
    let relayUrl;
    try {
      relayUrl = await resolveRelayUrl(meta.orgId);
    } catch (e) {
      return { ok: false, error: `this Agent has no public domain, so OpenMax Browser cannot reach it (${scrub(e.message)})` };
    }
    try { await ensureComponent(); } catch (e) {
      return { ok: false, error: e.tooOld || e.message === TOO_OLD ? TOO_OLD : `browser-remote install/upgrade failed: ${scrub(e.message)}` };
    }
    try { await ensureRunning(); } catch (e) {
      return { ok: false, error: `browser-remote is not running: ${scrub(e.message)}` };
    }
    try {
      const { key, keyId } = await mintKey(meta.bindingId, { reuse });
      return { ok: true, relayUrl, key, keyId };
    } catch (e) {
      return { ok: false, error: e.message === TOO_OLD ? TOO_OLD : `creating the connection key failed: ${scrub(e.message)}` };
    }
  }

  async function prepare(meta) {
    const result = await produce(meta);
    if (!result.ok) warn(`[${meta.slug}] browser prepare failed connection=${meta.bindingId}: ${result.error}`);
    else log(`[${meta.slug}] browser prepare minted key_id=${result.keyId} connection=${meta.bindingId}`);
    await reportPrepare(meta, result);
  }

  async function postAck(orgId, connectionId, keyId) {
    await postForOrg(orgId, apiPath(`/connect/browser-connections/${connectionId}/revoke-ack`),
      { key_id: keyId }, { timeoutMs: callbackTimeoutMs });
  }

  async function revoke(meta) {
    const connectionId = meta.bindingId;
    let revokedIds = [];
    try {
      const mine = (await listKeys()).filter((k) => k?.connectionId === connectionId);
      for (const k of mine) {
        await revokeKey(k.keyId);
        revokedIds.push(k.keyId);
      }
      forget(connectionId);
    } catch (e) {
      // Without key.js we cannot prove the Key is gone: do not ack. cws-connect
      // re-pushes an un-acked revoke, so this is retried.
      warn(`[${meta.slug}] browser revoke failed connection=${connectionId}: ${scrub(e.message)}`);
      return;
    }
    // revoke-ack's key_id must equal the one cws-connect stored (empty if none
    // was ever issued). The command carries no key_id, so try what we revoked,
    // then the last key we minted for it, then ''. A mismatch is a 4xx.
    const remembered = readRecord()[connectionId];
    const candidates = [...new Set([...revokedIds, remembered, ''].filter((x) => x !== undefined && x !== null))];
    for (const keyId of candidates) {
      try {
        await postAck(meta.orgId, connectionId, keyId);
        log(`[${meta.slug}] browser revoke acked connection=${connectionId} key_id=${keyId || '(none)'}`
          + ` (revoked ${revokedIds.length} key(s))`);
        remember(connectionId, null);
        return;
      } catch (e) {
        if (!(e?.status >= 400 && e.status < 500)) {
          warn(`[${meta.slug}] browser revoke-ack failed connection=${connectionId}: ${scrub(e.message)}`
            + ' — cws-connect will re-push the revoke');
          return;
        }
      }
    }
    warn(`[${meta.slug}] browser revoke-ack rejected for every key_id candidate connection=${connectionId}`);
  }

  async function handleCommand(orgConfig, frame) {
    try {
      const data = frame?.payload?.data;
      if (!data) return;
      const slug = orgConfig.slug;
      const { action, binding_id: bindingId, request_id: requestId } = data;
      if (!bindingId) { warn(`[${slug}] browser-remote command without binding_id`); return; }
      if (!isEventForMe(data, orgConfig.self?.member_id)) return;
      const act = String(action || '').toLowerCase();
      if (act !== 'prepare' && act !== 'revoke') {
        warn(`[${slug}] unknown browser-remote action '${action}' connection=${bindingId}`);
        return;
      }
      if (dedupe(`browser-remote:${act}:${bindingId}:${requestId || ''}`)) {
        log(`[${slug}] browser-remote ${act} dedup connection=${bindingId} request=${requestId}`);
        return;
      }
      const meta = { slug, orgId: orgConfig.org_id, bindingId, requestId };
      log(`[${slug}] browser-remote ${act} connection=${bindingId} request=${requestId}`);
      await serial(bindingId, () => (act === 'prepare' ? prepare(meta) : revoke(meta)));
    } catch (e) {
      warn(`[${orgConfig?.slug}] browser-remote command crashed: ${scrub(e?.message || e)}`);
    }
  }

  async function listActive(orgId) {
    const resp = await getForOrg(orgId, apiPath('/connect/agent-browser-connections'));
    const items = Array.isArray(resp) ? resp : resp?.data;
    if (!Array.isArray(items)) throw new Error('agent-browser-connections: unexpected response');
    return items;
  }

  /**
   * Resend one queued prepare-result. Throws to keep it queued. For ok
   * entries the Key was never persisted: if cws-connect already lists the
   * connection as ready/connected the earlier POST landed (nothing to do);
   * otherwise mint a fresh Key and report it with the original request_id.
   */
  async function resendPrepare(item) {
    const meta = { slug: item.slug, orgId: item.orgId, bindingId: item.bindingId, requestId: item.requestId };
    if (item.status !== 'ok') {
      try {
        await postPrepareResult(meta.orgId, meta.bindingId,
          { request_id: meta.requestId || '', ok: false, error: item.detail || 'prepare failed' });
      } catch (e) {
        if (!isFinalHttpError(e)) throw e;
        warn(`[${meta.slug}] browser prepare-result resend rejected connection=${meta.bindingId}`
          + ` (HTTP ${e.status}): ${scrub(e.message)} — dropped`);
      }
      return;
    }
    await serial(meta.bindingId, async () => {
      const active = await listActive(meta.orgId);
      if (active.some((c) => c?.connection_id === meta.bindingId && c?.key_id)) return;
      const result = await produce(meta, { reuse: true });
      const body = result.ok
        ? { request_id: meta.requestId || '', ok: true, relay_url: result.relayUrl, key_id: result.keyId, key: result.key }
        : { request_id: meta.requestId || '', ok: false, error: scrub(result.error) };
      try {
        await postPrepareResult(meta.orgId, meta.bindingId, body);
        forget(meta.bindingId);
      } catch (e) {
        if (isFinalHttpError(e)) {
          // Resolve so the queue drops the entry: a rejected request stays rejected.
          warn(`[${meta.slug}] browser prepare-result resend rejected connection=${meta.bindingId}`
            + ` (HTTP ${e.status}): ${scrub(e.message)} — dropped`);
          if (result.ok) await discardKey(meta.bindingId, result.keyId);
          return;
        }
        throw new Error(scrub(e.message));
      }
    });
  }

  /**
   * Revoke local Workspace Keys whose connection is no longer active in any
   * org. Skips the whole pass when any org's list fails (never revoke on a
   * partial view), Keys without a connectionId, Keys younger than the grace
   * period, and connections with a queued prepare-result.
   * @returns {Promise<{revoked:string[], kept:number, skipped?:string}>}
   */
  async function reconcile(orgConfigs) {
    const orgs = [...(orgConfigs || [])].filter((o) => o?.org_id);
    if (!orgs.length) return { revoked: [], kept: 0, skipped: 'no orgs' };
    let keys;
    try {
      if (!(await isInstalled())) return { revoked: [], kept: 0, skipped: 'not installed' };
      keys = await listKeys();
    } catch (e) {
      return { revoked: [], kept: 0, skipped: `key list: ${scrub(e.message)}` };
    }
    const workspaceKeys = keys.filter((k) => k?.connectionId);
    if (!workspaceKeys.length) return { revoked: [], kept: 0 };
    const active = new Set();
    for (const o of orgs) {
      try {
        for (const c of await listActive(o.org_id)) if (c?.connection_id) active.add(c.connection_id);
      } catch (e) {
        warn(`[${o.slug}] browser reconcile skipped: listing active connections failed: ${scrub(e.message)}`);
        return { revoked: [], kept: workspaceKeys.length, skipped: 'list failed' };
      }
    }
    const queued = new Set((readQueued() || []).filter((x) => x?.kind === 'browser-prepare').map((x) => x.bindingId));
    const revoked = [];
    let kept = 0;
    for (const k of workspaceKeys) {
      const created = Date.parse(k.createdAt || '');
      const young = Number.isFinite(created) && now() - created < reconcileGraceMs;
      if (active.has(k.connectionId) || queued.has(k.connectionId) || young || chains.has(k.connectionId)) {
        kept++;
        continue;
      }
      try {
        await serial(k.connectionId, () => revokeKey(k.keyId));
        if (minted.get(k.connectionId)?.keyId === k.keyId) forget(k.connectionId);
        revoked.push(k.keyId);
        log(`[browser-remote] reconcile revoked orphan key ${k.keyId} (connection ${k.connectionId})`);
      } catch (e) {
        warn(`[browser-remote] reconcile could not revoke ${k.keyId}: ${scrub(e.message)}`);
      }
    }
    return { revoked, kept };
  }

  return { handleCommand, resendPrepare, reconcile, _scrub: scrub };
}
