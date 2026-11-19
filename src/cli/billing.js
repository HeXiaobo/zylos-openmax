#!/usr/bin/env node

/**
 * Billing CLI — read-only answers to "how many credits are left / which plan /
 * when does it renew / which Agent spends the most" (OPENM-1375,
 * workspace-backlog#817), using the Agent's OWN token (no usage credential).
 *
 * Usage:
 *   node src/cli/billing.js <command> '<json-params>'
 *   node src/cli/billing.js billing.overview '{"conversationId":"<uuid>","messageId":"<digits>"}'
 *   node src/cli/billing.js billing.spend    '{"conversationId":"<uuid>","messageId":"<digits>","period":"month","top":5}'
 *   node src/cli/billing.js billing.overview '{"channel":"lark","endpoint":"<reply-via endpoint>"}'
 *
 * Every numeric command first runs the initiator gate (src/lib/billing-gate.js):
 * only an org Owner / admin gets numbers; anyone else gets `allowed:false` and
 * a fixed `reply`, and no billing request is made. Each call appends one line
 * to the local audit log (src/lib/billing-audit.js).
 *
 * Read-only: purchase / upgrade / top-up / auto-recharge are web-only
 * (`billing.links` returns the credit page URL).
 *
 * Output: JSON on stdout (a denial is a normal result, exit 0); errors are
 * JSON on stderr with exit code 1.
 */

import { fileURLToPath } from 'node:url';
import {
  checkInitiator, DENIED_REPLY, EXTERNAL_REDIRECT_REPLY, OWNER_UNVERIFIABLE_REPLY, UNAVAILABLE_REPLY,
} from '../lib/billing-gate.js';
import { fetchOverview, fetchSpend, resolveSpendRange, CREDIT_PAGE_PATH, DEFAULT_TOP } from '../lib/billing-query.js';
import { appendAudit } from '../lib/billing-audit.js';

// Billing response fields kept out of the [rpc] log lines.
const LOG_REDACT_KEYS = ['subscription', 'usage_snapshot', 'current_payment_method', 'entitlements', 'addons',
  'consumptions', 'grants', 'expiries', 'manual_adjustments', 'balance'];

const GATED = new Set(['billing.overview', 'billing.spend', 'billing.check_access']);

export const PURCHASE_NOTE = '购买积分包、升级套餐、扩容、自动充值都需要在网页上由 Owner/管理员操作，我这里只能查看。\n'
  + 'Buying credits, upgrading the plan, adding seats and auto top-up are done on the web; I can only read billing information.';

async function defaultDeps(params) {
  const { getForOrg, apiPath, frontendUrl } = await import('../lib/client.js');
  const { enabledOrgs, getOrgByOrgId, resolveDefaultOrgId } = await import('../lib/config.js');
  const { lookupConvOrg } = await import('../lib/conv-org.js');
  const key = params.org || params.orgId || params.org_id;
  let orgId = '';
  if (key) {
    const hit = enabledOrgs().find((o) => o.slug === key || o.org_id === key
      || (o.org_name && String(o.org_name).toLowerCase() === String(key).toLowerCase()));
    orgId = hit?.org_id || String(key);
  } else {
    orgId = (typeof params.conversationId === 'string' && lookupConvOrg(params.conversationId)) || resolveDefaultOrgId();
  }
  const get = (path, query) => {
    if (!orgId) {
      throw Object.assign(new Error('cannot resolve org: multiple orgs enabled and no org given — pass {"org":"<org_id>"} or set COCO_ORG_ID'), { status: 400 });
    }
    return getForOrg(orgId, apiPath(path), query, { timeoutMs: 20000, quietOnSuccess: true, logRedactKeys: LOG_REDACT_KEYS });
  };
  const selfMemberId = async () => {
    const configured = getOrgByOrgId(orgId)?.self?.member_id;
    if (configured) return configured;
    const me = await get('/me');
    return me?.member_id || '';
  };
  let creditPageUrl = null;
  try { creditPageUrl = frontendUrl(CREDIT_PAGE_PATH); } catch { creditPageUrl = null; }
  return { get, orgId, selfMemberId, creditPageUrl, now: Date.now() };
}

function auditBase(command, params, deps, gate) {
  return {
    command,
    allowed: gate ? gate.allowed : undefined,
    reason: gate?.reason,
    source: gate?.source,
    channel: gate?.channel,
    asker_is_agent_owner: gate?.asker_is_agent_owner,
    private_chat: gate?.private_chat,
    initiator_member_id: gate?.initiator_member_id,
    role: gate?.role,
    conversation_id: typeof params.conversationId === 'string' ? params.conversationId : undefined,
    message_id: params.messageId !== undefined ? String(params.messageId) : undefined,
    org_id: deps.orgId || undefined,
    error_status: gate && Object.hasOwn(gate, 'status') ? gate.status : undefined,
  };
}

function initiatorView(gate) {
  const out = { source: gate.source, role: gate.role, member_id: gate.initiator_member_id ?? null };
  if (gate.initiator_name) out.name = gate.initiator_name;
  if (gate.channel) out.channel = gate.channel;
  return out;
}

/**
 * Run one command. `deps` (tests): { get, orgId, selfMemberId, now, creditPageUrl, audit }.
 * Returns { ok, result } or throws.
 */
export async function runCommand(command, params = {}, deps = {}) {
  const audit = deps.audit || appendAudit;
  if (command === 'billing.links') {
    return { credit_page_url: deps.creditPageUrl ?? null, note: PURCHASE_NOTE };
  }
  if (!GATED.has(command)) throw Object.assign(new Error(`Unknown command: ${command}`), { status: 400 });
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw Object.assign(new Error('Expected a JSON object'), { status: 400 });

  const now = deps.now ?? Date.now();
  // Validate the range before asking anyone (no numbers involved yet).
  let range = null;
  if (command === 'billing.spend' && params.period !== 'billing_period') range = resolveSpendRange(params, { now, timeZone: deps.timeZone });

  const gate = await checkInitiator(params, {
    get: deps.get, orgId: deps.orgId, selfMemberId: deps.selfMemberId, now, imOwner: deps.imOwner,
  });
  const base = auditBase(command, params, deps, gate);
  if (!gate.allowed) {
    audit(base);
    const unavailable = gate.reason === 'verification_unavailable';
    const unverifiable = gate.reason === 'owner_unverifiable';
    return {
      allowed: false,
      reason: gate.reason,
      ...(unavailable ? { status: gate.status ?? null } : {}),
      reply: unavailable ? UNAVAILABLE_REPLY
        : unverifiable ? OWNER_UNVERIFIABLE_REPLY
          : (gate.redirect ? EXTERNAL_REDIRECT_REPLY : DENIED_REPLY),
      ...(gate.source === 'channel' && !unavailable && !gate.redirect ? { hint: 'An org Owner/admin can ask in a Workspace DM with this Agent.' } : {}),
    };
  }
  const head = { allowed: true, initiator: initiatorView(gate), credit_page_url: deps.creditPageUrl ?? null };
  try {
    if (command === 'billing.check_access') {
      audit(base);
      return head;
    }
    if (command === 'billing.overview') {
      const data = await fetchOverview(deps.get);
      audit(base);
      return { ...head, ...data };
    }
    // billing.spend
    if (!range) {
      const ps = await deps.get('/billing/plan-state');
      range = resolveSpendRange(params, { now, timeZone: deps.timeZone, billingPeriodStart: ps?.subscription?.current_period_start });
    }
    const top = params.top === undefined ? DEFAULT_TOP : params.top;
    if (!Number.isInteger(top) || top < 1 || top > 100) throw Object.assign(new Error('top must be an integer 1..100'), { status: 400 });
    const data = await fetchSpend(deps.get, { start: range.start, end: range.end, top });
    audit({ ...base, range: { start: data.range.start, end: data.range.end, label: range.label } });
    return { ...head, period: range.label, time_zone: range.timeZone, ...data };
  } catch (err) {
    audit({ ...base, error_status: Number.isInteger(err?.status) ? err.status : null });
    throw err;
  }
}

function printUsage() {
  console.log(`Usage: node src/cli/billing.js <command> '<json>'

Read-only billing answers for org Owners/admins (Agent's own token).
Initiator (required for every numeric command — exactly one form):
  Workspace message:  {"conversationId":"<uuid>","messageId":"<digits>"}
                      copied from the inbound <message-context conversation-id source-message-id>
  External IM:        {"channel":"lark","endpoint":"<endpoint>"}
                      channel + endpoint copied verbatim from the inbound "reply via" line;
                      answered only in a private chat with this Agent's bound owner
Optional: org (org_id / config key / name; default from the conversation or the single org)

Commands:
  billing.check_access {initiator}                      # allowed? (no numbers)
  billing.overview     {initiator}                      # balance, plan, status, renewal, next charge
  billing.spend        {initiator, period?|last?|rangeStart+rangeEnd?, top?}
                       period: month (default, agent time zone) | billing_period
                       last: Nd (1..366); rangeStart/rangeEnd RFC3339, max 366 days
                       (split into ≤92-day statement windows); top 1..100 (default 10)
  billing.links        {}                               # credit page URL for buying/upgrading (web only)

Denied → {"allowed":false,"reason":…,"reply":…}: send "reply" as-is, no numbers.
Details: references/billing-operations.md`);
}

export async function runCli(args = process.argv.slice(2), deps) {
  const [command, ...rest] = args;
  if (!command || ['help', '--help', '-h'].includes(command)) { printUsage(); return; }
  try {
    let params = {};
    if (rest.length) {
      try { params = JSON.parse(rest.join(' ')); } catch { throw Object.assign(new Error('Invalid JSON parameters'), { status: 400 }); }
    }
    const d = deps || (command === 'billing.links' || GATED.has(command) ? await defaultDeps(params ?? {}) : {});
    console.log(JSON.stringify(await runCommand(command, params, d), null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    console.error(JSON.stringify(payload));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runCli();
