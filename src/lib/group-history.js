/**
 * In-memory + file-backed group message history for openmax.
 *
 * Mirrors zylos-telegram's context.js pattern:
 *   - Every group message (handled or not) is recorded via logAndRecord(),
 *     and every sub-conversation message (DM ones too) under the
 *     sub-conversation's own id; plain DMs are not recorded
 *   - getHistory() reads from memory (fast path)
 *   - ensureReplay() populates memory from log files on cold start
 *   - API fetch is the final fallback (caller's responsibility)
 *
 * Log files: ~/zylos/components/openmax/runtime/group-logs/{conversationId}.log
 * Format: NDJSON, one HistoryEntry per line.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';

const LOGS_DIR = path.join(RUNTIME_DIR, 'group-logs');
// Full plaintext group chat transcripts live here — 0700, not the default umask.
fs.mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(LOGS_DIR, 0o700); } catch {}

const LOG_PREFIX = '[group-history]';

/**
 * @typedef {Object} HistoryEntry
 * @property {string} timestamp - ISO 8601
 * @property {string} message_id - cws-comm message ID
 * @property {string} sender_id - member ID
 * @property {string} sender_name - display name
 * @property {string} text - message text (may include media labels)
 * @property {number|null} seq - message sequence number (for ordering)
 * @property {string|null} parent_id - parent message ID (for reply chains)
 * @property {string|null} type - message type (text/image/file)
 */

/** @type {Map<string, Array<HistoryEntry>>} */
const chatHistories = new Map();

/** @type {Set<string>} Track which conversation IDs have been replayed */
const _replayedKeys = new Set();

let _historyLimit = 5;
let _maxLimit = 15;

export function setLimits(base, max) {
  _historyLimit = base || 5;
  _maxLimit = max || 15;
}

function getLimit() {
  return _historyLimit;
}

/**
 * Compare two message ids for identity, tolerating JSON type drift.
 *
 * `message_id` is written straight off the inbound frame (comm-bridge.js builds
 * the entry with `message_id: msg.id`, unnormalized — unlike the `seq` on the
 * next line, which is coerced with Number()). cws-comm emits that id as a JSON
 * number on some delivery paths and as a string on others, so a single log file
 * routinely holds both shapes.
 *
 * A strict `===` between 1786027449978 and "1786027449978" is false, which
 * would defeat both identity checks below: the dedup in recordHistoryEntry
 * (same message recorded twice, and appended to the log a second time) and the
 * exclude filter in getHistory (the current message leaking into the context
 * built for itself, so the model sees it said twice).
 *
 * Normalizing at comparison time rather than on write is deliberate: entries
 * replayed from disk by ensureReplay() carry whatever shape was already
 * persisted, so this keeps pre-existing logs working with no migration.
 */
function sameMessageId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/**
 * Record a message into in-memory history.
 * Deduplicates by message_id.
 */
function recordHistoryEntry(conversationId, entry) {
  if (!chatHistories.has(conversationId)) chatHistories.set(conversationId, []);
  const history = chatHistories.get(conversationId);

  if (entry.message_id) {
    if (history.some(m => sameMessageId(m.message_id, entry.message_id))) return;
  }

  history.push(entry);
  const limit = getLimit();
  if (history.length > limit * 2) {
    chatHistories.set(conversationId, history.slice(-limit));
  }
}

/**
 * Append a log entry to file AND record in memory.
 * Called for every group message regardless of policy outcome.
 */
// Tracks which log files this process has already chmod'd, so a pre-existing
// 0644 file (from before this hardening) gets fixed once without paying a
// chmodSync syscall on every single message append.
const _hardenedLogFiles = new Set();

export function logAndRecord(conversationId, entry) {
  conversationId = String(conversationId);

  const logFile = path.join(LOGS_DIR, conversationId + '.log');
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    if (!_hardenedLogFiles.has(logFile)) {
      _hardenedLogFiles.add(logFile);
      try { fs.chmodSync(logFile, 0o600); } catch {}
    }
  } catch (err) {
    console.error(LOG_PREFIX, `log write failed for ${conversationId}: ${err.message}`);
  }

  recordHistoryEntry(conversationId, entry);
}

/**
 * Get recent context messages from in-memory history.
 * Returns up to `limit` entries, excluding the specified message.
 * Returns null if no local history is available (caller should fall back to API).
 */
export function getHistory(conversationId, excludeMessageId, limit) {
  conversationId = String(conversationId);
  const history = chatHistories.get(conversationId);
  if (!history || history.length === 0) return null;

  const effectiveLimit = limit || getLimit();
  const filtered = excludeMessageId
    ? history.filter(m => !sameMessageId(m.message_id, excludeMessageId))
    : history;
  return filtered.slice(-effectiveLimit);
}

/**
 * Ensure in-memory history is populated for a conversation.
 * On first access after restart, reads tail of the log file.
 */
export function ensureReplay(conversationId) {
  conversationId = String(conversationId);
  if (_replayedKeys.has(conversationId)) return;

  const logFile = path.join(LOGS_DIR, conversationId + '.log');
  if (!fs.existsSync(logFile)) {
    _replayedKeys.add(conversationId);
    return;
  }

  const limit = getLimit();

  try {
    const stat = fs.statSync(logFile);
    const BYTES_PER_ENTRY = 512;
    const readSize = Math.min(stat.size, limit * BYTES_PER_ENTRY * 2);
    let content;
    if (readSize < stat.size) {
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(logFile, 'r');
      try {
        fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      } finally {
        fs.closeSync(fd);
      }
      const text = buf.toString('utf-8');
      const firstNewline = text.indexOf('\n');
      content = firstNewline !== -1 ? text.substring(firstNewline + 1) : text;
    } else {
      content = fs.readFileSync(logFile, 'utf-8');
    }
    const lines = content.trim().split('\n').filter(l => l);
    const tail = lines.slice(-limit);

    for (const line of tail) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      recordHistoryEntry(conversationId, entry);
    }

    _replayedKeys.add(conversationId);
    if (tail.length > 0) {
      console.log(LOG_PREFIX, `replayed ${tail.length} log entries for ${conversationId}`);
    }
  } catch (err) {
    console.error(LOG_PREFIX, `replay failed for ${conversationId}: ${err.message}`);
  }
}
