/**
 * Inbound bridge to zylos-core: calls comm-bridge c4-receive.
 *
 * - Capability probe: `--session-group` is passed only when the installed
 *   Core lists it in c4-receive-options.json, read once per inbound message
 *   (readInboundCaps), never inferred from a version. On an older Core (0.9.x)
 *   no session group is derived, the endpoint carries no `|type:`, and the argv
 *   is exactly what it was before.
 * - The session group comes from the endpoint (src/lib/session-group.js), so
 *   it always matches what `scripts/session-group.js` answers for a reply.
 *   An endpoint that cannot be mapped is not sent at all (never to the overall
 *   `openmax` group): the user gets TRY_LATER.
 * - Core's error text is written for the agent, never for the OpenMax user:
 *   users only ever see TRY_LATER or MAYBE_LOST; the raw text stays in the logs.
 * - c4-receive is killed after C4_RECEIVE_TIMEOUT_MS (30s, as before). A
 *   timeout is an unknown outcome: MAYBE_LOST, nothing resent. Only a call that
 *   never started (spawn failure) is retried, once; a stored or unknown outcome
 *   is never resent, and a rejected group is never resent without the group.
 *
 * Kept out of comm-bridge.js, which has side-effecting top-level startup code
 * and cannot be imported by a test.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { sessionGroupFromEndpoint } from './session-group.js';

export const TRY_LATER = '暂时无法接收这条消息，请稍后再试。\n'
  + "Sorry, I couldn't take this message right now. Please try again later.";
export const MAYBE_LOST = '这条消息可能没有送达。如果几分钟内没有收到回复，请重新发送。\n'
  + "Sorry, this message may not have reached me. If you don't get a reply in a few minutes, please send it again.";
/** A card answer that could not be routed (appendix C of the plan). */
export const CARD_RETRY = '这次卡片操作暂时没能处理，请稍后重新提交。\n'
  + "Sorry, I couldn't process this card response right now. Please submit it again later.";

export const C4_RECEIVE_TIMEOUT_MS = 30000;
export const SPAWN_RETRY_DELAY_MS = 2000;

/**
 * c4-receive.js of the deployment this component runs in.
 * @returns {string}
 */
export function getC4ReceivePath() {
  return path.join(process.env.HOME || '', 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
}

/**
 * What the installed c4-receive supports. Re-reads c4-receive-options.json
 * next to c4-receive.js on every call; a missing, unreadable or malformed file
 * means "not supported". Call it once per inbound message and pass the result
 * along, so the endpoint and the argv of one message agree.
 * @param {string} [receivePath]
 * @returns {{sessionGroup: boolean}}
 */
export function readInboundCaps(receivePath = getC4ReceivePath()) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(path.dirname(receivePath), 'c4-receive-options.json'), 'utf8'));
    const options = manifest?.options;
    const ok = options !== null && typeof options === 'object' && !Array.isArray(options)
      && Object.hasOwn(options, '--session-group');
    return { sessionGroup: ok };
  } catch {
    return { sessionGroup: false };
  }
}

/**
 * Arguments after the c4-receive.js path. Without a session group this is the
 * argv the bridge has always passed: c4-receive.js only accepts named flags
 * (--channel / --endpoint / --content / --json / --priority).
 * @returns {string[]}
 */
export function buildC4ReceiveArgs({ channel, endpoint, content, priority, sessionGroup }) {
  const args = ['--channel', channel, '--endpoint', endpoint, '--json'];
  // System events map urgent/high/normal → 1/2/3 so urgent platform messages
  // (e.g. approval unblock) jump ahead of normal chat. Omit for normal/chat so
  // c4-receive applies its default (3). See lib/system-message.js.
  if (Number.isInteger(priority) && priority >= 1 && priority <= 3) {
    args.push('--priority', String(priority));
  }
  args.push('--content', content);
  if (sessionGroup) args.push('--session-group', sessionGroup);
  return args;
}

/**
 * Classify a structured c4-receive rejection by `error.persisted`:
 * - non-empty array: the inbound row was stored ('stored') - send nothing, never resend
 * - empty array: nothing was stored ('not_stored') - ask the user to try later
 * - null / absent (older Cores): Core cannot tell ('uncertain')
 * @param {object} response - parsed `{ ok: false, error }` JSON
 * @returns {'stored'|'not_stored'|'uncertain'}
 */
export function classifyC4Rejection(response) {
  const persisted = response?.error?.persisted;
  if (!Array.isArray(persisted)) return 'uncertain';
  return persisted.length > 0 ? 'stored' : 'not_stored';
}

/**
 * Parse c4-receive JSON response from stdout.
 * @returns {object|null}
 */
export function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(String(stdout).trim());
  } catch {
    return null;
  }
}

function isStructuredRejection(response) {
  return response !== null && typeof response === 'object' && response.ok === false
    && response.error !== null && typeof response.error === 'object';
}

/**
 * True when c4-receive never started (spawn itself failed), so Core cannot
 * have stored anything. Any other failure without a structured result
 * (non-zero exit, signal, timeout, maxBuffer) has an unknown outcome.
 */
function neverStarted(error) {
  return typeof error?.syscall === 'string' && error.syscall.startsWith('spawn');
}

/** Backoff before the one retry of a conversation-record fetch. */
export const CONVERSATION_RETRY_DELAY_MS = 300;

/**
 * Fetch a conversation record, retrying once after a short backoff.
 * `fetchOnce` resolves the record, or null / throws when it could not be read.
 * @returns {Promise<object|null>}
 */
export async function fetchConversationRecord(fetchOnce, { retryDelayMs = CONVERSATION_RETRY_DELAY_MS } = {}) {
  const attempt = async () => {
    try { return (await fetchOnce()) || null; } catch { return null; }
  };
  const first = await attempt();
  if (first) return first;
  await new Promise((r) => setTimeout(r, retryDelayMs));
  return attempt();
}

/**
 * Whether an inbound message must wait because its conversation's kind cannot
 * be told yet (multi-session Core only): no record (after the retry) and no
 * stored type. A record or stored type that names a kind without a session
 * group (STRAT, …) is an answer, not a wait — that message is refused later.
 * @param {{sessionGroup:boolean}} caps
 * @param {object|null} record - fetchConversationRecord result
 * @param {object|null} stored - conv-org.js lookupConvRecord result
 */
export function conversationKindPending(caps, record, stored) {
  return !!caps?.sessionGroup && !record && !(stored && stored.type);
}

/**
 * Hand one inbound message to Core.
 *
 * @param {object} msg
 * @param {string} msg.channel - 'openmax'
 * @param {string} msg.endpoint - the reply endpoint (message.js formatEndpoint)
 * @param {string} msg.content - the C4 body
 * @param {number} [msg.priority]
 * @param {{sessionGroup:boolean}} msg.caps - readInboundCaps() of this message
 * @param {object} [opts]
 * @param {function} [opts.log] / [opts.warn]
 * @param {function} [opts.execFileImpl] - test hook (child_process.execFile)
 * @param {string} [opts.receivePath]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retryDelayMs]
 * @returns {Promise<{outcome:'sent'|'stored'|'not_stored'|'uncertain'|'unknown'|'failed'|'no_group',
 *   notice:string|null, stdout?:string, sessionGroup?:string}>}
 *   `notice` is the text to show the user (TRY_LATER / MAYBE_LOST), null when
 *   nothing should be shown ('sent', 'stored').
 */
export async function forwardToC4({ channel, endpoint, content, priority, caps }, {
  log = () => {}, warn = () => {}, execFileImpl = execFile, receivePath = getC4ReceivePath(),
  timeoutMs = C4_RECEIVE_TIMEOUT_MS, retryDelayMs = SPAWN_RETRY_DELAY_MS,
} = {}) {
  let sessionGroup;
  if (caps?.sessionGroup) {
    try {
      sessionGroup = sessionGroupFromEndpoint(endpoint);
    } catch (err) {
      // Never fall back to the overall group: that would mix this conversation into it.
      warn(`No session group for endpoint, not sending to C4: ${err.message}`);
      return { outcome: 'no_group', notice: TRY_LATER };
    }
  }
  const args = [receivePath, ...buildC4ReceiveArgs({ channel, endpoint, content, priority, sessionGroup })];
  const group = sessionGroup ?? 'none';
  const run = () => new Promise((resolve) => {
    execFileImpl(process.execPath, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout ?? error?.stdout, stderr });
    });
  });

  const settle = ({ error, stdout }, label) => {
    if (!error) return { outcome: 'sent', notice: null, stdout, ...(sessionGroup ? { sessionGroup } : {}) };
    const response = parseC4Response(stdout);
    if (isStructuredRejection(response)) {
      const { code, message } = response.error;
      const kind = classifyC4Rejection(response);
      if (kind === 'stored') {
        warn(`C4 rejected${label} after storing (${code}) [group=${group}], not resending: ${message}`);
        return { outcome: 'stored', notice: null, stdout };
      }
      warn(`C4 rejected${label} (${code}, ${kind}) [group=${group}]: ${message}`);
      return { outcome: kind, notice: kind === 'not_stored' ? TRY_LATER : MAYBE_LOST };
    }
    return null;
  };

  const first = await run();
  const done = settle(first, '');
  if (done) return done;
  if (!neverStarted(first.error)) {
    warn(`c4-receive failed, outcome unknown, not resending [group=${group}]: ${first.stderr || first.error.message}`);
    return { outcome: 'unknown', notice: MAYBE_LOST };
  }
  // c4-receive never started, so nothing was stored - retry once.
  warn(`c4-receive did not start, retrying in ${retryDelayMs}ms: ${first.error.message}`);
  await new Promise((r) => setTimeout(r, retryDelayMs));
  const second = await run();
  const retried = settle(second, ' (retry)');
  if (retried) {
    if (retried.outcome === 'sent') log(`c4-receive succeeded on retry [group=${group}]`);
    return retried;
  }
  warn(`c4-receive failed after retry, not resending [group=${group}]: ${second.stderr || second.error.message}`);
  return { outcome: 'failed', notice: MAYBE_LOST };
}
