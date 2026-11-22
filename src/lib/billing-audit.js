/**
 * Local audit trail for billing questions (OPENM-1375): one JSON line per
 * query — who asked (member id + role, or channel + whether it was a private
 * chat with the channel's bound owner), which command, allowed or denied and why. Fields are
 * whitelisted, so tokens, keys, message text and billing numbers never reach
 * the file. Best-effort: a write failure never changes the answer.
 *
 * File: ~/zylos/components/openmax/logs/billing-audit.jsonl
 * (override: OPENMAX_BILLING_AUDIT_FILE).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function auditFilePath(env = process.env) {
  if (env.OPENMAX_BILLING_AUDIT_FILE) return env.OPENMAX_BILLING_AUDIT_FILE;
  return path.join(env.HOME || os.homedir(), 'zylos', 'components', 'openmax', 'logs', 'billing-audit.jsonl');
}

const FIELDS = ['command', 'allowed', 'reason', 'source', 'channel', 'private_chat', 'asker_is_agent_owner',
  'initiator_member_id', 'role', 'conversation_id', 'message_id', 'org_id', 'agent_member_id', 'range', 'error_status'];

const SAFE_STRING = /^[A-Za-z0-9_.:+@\-]{0,128}$/;

function clean(value) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return SAFE_STRING.test(value) ? value : '[invalid]';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Only the {start,end,label} range descriptor is an object.
    const out = {};
    for (const k of ['start', 'end', 'label']) if (value[k] !== undefined) out[k] = clean(value[k]);
    return out;
  }
  return undefined;
}

export function buildAuditRecord(fields, now = new Date()) {
  const rec = { ts: now.toISOString() };
  for (const k of FIELDS) {
    if (fields?.[k] === undefined) continue;
    const v = clean(fields[k]);
    if (v !== undefined) rec[k] = v;
  }
  return rec;
}

export function appendAudit(fields, { file = auditFilePath(), now = new Date() } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(buildAuditRecord(fields, now))}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
