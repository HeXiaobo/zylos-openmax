#!/usr/bin/env node

/**
 * Core CLI — read-mostly directory queries against the core service
 * (paths and params per the core service's live OpenAPI spec).
 *
 * Usage:
 *   node src/cli/core.js <command> '<json-params>'
 *   node src/cli/core.js core.me            '{}'
 *   node src/cli/core.js core.member_list   '{"kind":"agent","limit":50}'
 *
 * Status:
 *   ✅  available in the core service today
 *   ⏳  not exposed by the core service yet (call will 404); kept here so the
 *      surface is ready when core adds the endpoint
 */

import { get, post, patch, apiPath, frontendUrl, getForOrg, getForOrgWithHeaders, postForOrg, delForOrg } from '../lib/client.js';
import { enabledOrgs, updateConfig, resolveDefaultOrgId, getOrgByOrgId } from '../lib/config.js';
import { resolveAgentBaseUrl } from '../lib/agent-domain.js';
import { agentTimeZone, isValidTimeZone, canonicalTimeZone, nextWallClockTime, describeLocalMinute } from '../lib/local-time.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

// Org resolution for the ORG-OWNED commands (mirrors conn.js PR#127). The backend
// resolves the org from the JWT principal and 403s ("org membership required")
// on an identity-only token for these routes. A bare get()/post() would silently
// fall through to resolveDefaultOrgId(), which returns '' when >1 org is enabled
// and no org is given — producing that opaque 403. The org-scoped helpers below
// FAIL FAST with an actionable 400 instead. Single-org / COCO_ORG_ID unchanged.
//
// NOTE: this is used ONLY by the org-owned commands (oget/opost/odel). The
// identity / bootstrap commands (self_rename, org_list, org_create,
// org_switch, invitation_accept, agent_domain) DELIBERATELY keep the bare
// get/post/patch — they are identity-scoped by definition and must NOT be forced
// org (doing so would break cross-org / bootstrap flows). For org_get the {orgId}
// path param doubles as the operating org, so reading a specific org uses that
// org's own JWT.
// core.me preserves the bootstrap path unless an explicit org is supplied;
// then its member identity must be resolved using that org's JWT.
function resolveOrgId() {
  return params.org || params.orgId || params.org_id || resolveDefaultOrgId();
}
function requireOrgId() {
  const orgId = resolveOrgId();
  if (!orgId) {
    throw Object.assign(
      new Error('cannot resolve org: multiple orgs enabled and no org given — pass {"org":"<org_id>"} or set COCO_ORG_ID'),
      { status: 400 },
    );
  }
  return orgId;
}
const oget  = (path, query) => getForOrg(requireOrgId(), path, query);
const opost = (path, body)  => postForOrg(requireOrgId(), path, body);
const odel  = (path)        => delForOrg(requireOrgId(), path);
// Onboarding label language: `lang` (zh|en) → Accept-Language, which is how
// cws-core picks `label` / role labels; omitted → the deployment edition decides.
const onboardingLangHeaders = () => {
  const lang = String(params.lang || params.locale || '').trim();
  return lang ? { 'Accept-Language': lang } : {};
};

/** Normalize a scalar-or-array param into an array (drops null/undefined). */
const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function projectMemberPageQuery() {
  const pageSize = params.pageSize !== undefined ? params.pageSize : params.limit;
  if (params.cursor !== undefined || params.next_cursor !== undefined) {
    throw Object.assign(new Error('core.project_members uses page/pageSize, not cursor pagination'), { status: 400 });
  }
  for (const [name, value, max] of [['page', params.page, 2147483647], ['pageSize', pageSize, 100]]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > max)) {
      throw Object.assign(new Error(`core.project_members ${name} must be an integer from 1 to ${max}`), { status: 400 });
    }
  }
  return { page: params.page, page_size: pageSize };
}

/**
 * Rename the agent itself (self-service display name change).
 *
 * Two sides are kept in sync:
 *   1. the core service — `PATCH /api/v1/me {display_name}`. display_name is an
 *      identity-level attribute (managed by the core service's Identities, per D15),
 *      so a single /me PATCH updates how the agent appears in EVERY org it
 *      has joined. We deliberately do NOT use the admin-only
 *      `PATCH /api/v1/members/{id}` here — the agent runs as an org-member,
 *      not an org-admin, so that route would 403.
 *   2. local config — mirror the new name into `orgs.<slug>.self.name` for
 *      every enabled org so the runtime's notion of its own name stays
 *      consistent with the core service.
 *
 * Prints only the new name + which orgs were synced. No tokens/secrets are
 * ever emitted (the RPC logger logs body+url only, never auth headers).
 */
async function selfRename(newName) {
  const name = typeof newName === 'string' ? newName.trim() : '';
  if (!name) {
    const err = new Error('self_rename requires a non-empty {name}');
    err.status = 400;
    throw err;
  }

  const updated = await patch(apiPath('/me'), { display_name: name });

  const orgs = enabledOrgs();
  if (orgs.length) {
    updateConfig((cfg) => {
      for (const { slug } of orgs) {
        const org = cfg.orgs?.[slug];
        if (!org) continue;
        org.self = { ...(org.self || {}), name };
      }
    });
  }

  return {
    display_name: updated?.display_name ?? name,
    identity_id:  updated?.identity_id,
    orgs_synced:  orgs.map((o) => o.slug),
  };
}

/**
 * Thin CLI wrapper over resolveAgentBaseUrl() (src/lib/agent-domain.js).
 * Resolves the agent's OWN public base URL for webhook-channel URL building:
 *   1. core service bound domain → base_url = "https://" + full_domain
 *   2. AGENT_PUBLIC_BASE_URL env fallback — ONLY when core answers 404
 *      (agent has no bound domain)
 *
 * On a resolved URL it returns the payload (main() prints it, exit 0). When
 * neither tier yields a URL it prints the `{ok:false,error}` shape and exits 1
 * — signalling failure like every other core.js command, but preserving the
 * structured result the resolver returns to library callers. Non-404 core
 * errors and malformed 200 responses (missing identity_id / full_domain)
 * throw from the resolver: per CLI conventions the message goes to stderr
 * with exit code 1 — never silently masked as an env fallback.
 */
async function agentDomainCommand() {
  const result = await resolveAgentBaseUrl();
  if (!result.ok) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  return result;
}

// ── core.pause_self ─────────────────────────────────────────────────────────
// An automation run whose instructions say "pause yourself after the run,
// resume at 08:30" ends with the Agent pausing ITSELF; the platform resumes it
// at that time. The platform enforces the order (the real pause is refused
// until the run's result is delivered), so this is a thin call: dryRun:true
// checks, without it pauses. The Agent's workflow (check → issue.deliver →
// pause) lives in references/automation-delivery.md.

// A resume time computed from `at` closer than this is refused locally
// (SELF_PAUSE_TOO_CLOSE): pausing for a few minutes is not worth it, and the
// next day's time would be a surprise. An explicit resumeAt is never held to
// it; the platform's own 10-minute bound decides.
const SELF_PAUSE_TOO_CLOSE_MS = 30 * 60 * 1000;

// Plain-English reasons for the refusals the Agent quotes as "未暂停：<reason>".
// SELF_PAUSE_* arrive as the error `code`; billing refusals arrive without a
// code, with Billing's reason as the `detail`. This CLI's own codes:
// SELF_PAUSE_TOO_CLOSE (refused locally), SELF_PAUSE_UNAVAILABLE (a 404 with
// no reason: a platform without the endpoint), SELF_PAUSE_NOT_PAUSED (a
// not_paused answer) and PERMISSION_DENIED (a 403 with no code and no reason).
const SELF_PAUSE_REASONS = {
  SELF_PAUSE_RESUME_AT_OUT_OF_RANGE: 'the resume time must be at least 10 minutes and at most 7 days from now',
  SELF_PAUSE_RUN_NOT_FOUND: 'the automation run was not found or is not visible to this Agent',
  SELF_PAUSE_NOT_AUTOMATION_RUN: 'the Issue is not an automation run led by this Agent',
  SELF_PAUSE_RUN_TOO_OLD: 'the automation run started too long ago; an Agent can pause itself only right after a run',
  SELF_PAUSE_OWNER_NOT_ADMIN: "the automation's owner must be an organization owner or admin",
  SELF_PAUSE_RUN_NOT_DELIVERED: 'deliver the run result first (tm.js issue.deliver), then call core.pause_self again',
  SELF_PAUSE_UNAVAILABLE: 'the platform does not support pausing an Agent after an automation run yet',
  SELF_PAUSE_TOO_CLOSE: 'the resume time is less than 30 minutes away; stay running instead of pausing',
  SELF_PAUSE_NOT_PAUSED: "this run's pause was not confirmed (it was refused, cancelled, or still unconfirmed close to the resume time); the Agent stays running",
  PERMISSION_DENIED: 'the platform does not allow this Agent to be paused (permission denied)',
  ADDON_NOT_FOUND: 'the Agent has no billing add-on to pause',
  AGENT_OPERATION_IN_PROGRESS: 'another pause or resume of this Agent is in progress',
  ADDON_INVALID_STATE: 'the Agent cannot be paused in its current state (for example, it is already paused)',
  INSUFFICIENT_BALANCE: 'the organization does not have enough credits',
  AGENT_CREDIT_CAP_BLOCKED: "the Agent's credit cap blocks this operation",
  OUTSTANDING_DEBT: 'the organization has an outstanding balance to settle',
};

const badParam = (msg) => Object.assign(new Error(`core.pause_self: ${msg}`), { status: 400 });

/** First present (not undefined) value among the camel/snake aliases. */
function aliasParam(...names) {
  for (const name of names) if (params[name] !== undefined) return params[name];
  return undefined;
}

function booleanParam(...names) {
  const value = aliasParam(...names);
  if (value !== undefined && typeof value !== 'boolean') {
    throw badParam(`${names[0]} must be true or false (a JSON boolean), got ${JSON.stringify(value)}`);
  }
  return value === true;
}

/**
 * "Now" for the resume-time computation. OPENMAX_TEST_NOW is TEST-ONLY: the
 * subprocess tests pin the clock with it (core.pause-self.test.js). Never set
 * it on a real Agent; the platform still checks the window against its own
 * clock.
 */
function selfPauseNow() {
  const pinned = process.env.OPENMAX_TEST_NOW;
  if (!pinned) return Date.now();
  const ms = Date.parse(pinned);
  if (!Number.isFinite(ms)) throw badParam(`OPENMAX_TEST_NOW (test-only) is not a time: ${JSON.stringify(pinned)}`);
  return ms;
}

/**
 * Validate the input and work out the resume instant — all before any HTTP.
 * Returns {issueId, dryRun, resumeAt (RFC3339 string), timeZone, tooClose}.
 * From `at`: the next such wall-clock time after now (today if still ahead,
 * else tomorrow; skipWeekend applied), `tooClose` when < 30 minutes away. An
 * explicit resumeAt is passed through and never `tooClose`.
 */
function selfPauseRequest() {
  const rawIssue = aliasParam('issueId', 'issue_id');
  const issueId = typeof rawIssue === 'string' ? rawIssue.trim() : '';
  if (!issueId) throw badParam('issueId (the automation run\'s Issue id) is required');
  const dryRun = booleanParam('dryRun', 'dry_run');
  const skipWeekend = booleanParam('skipWeekend', 'skip_weekend');
  const at = aliasParam('at');
  const explicit = aliasParam('resumeAt', 'resume_at');
  if ((at === undefined) === (explicit === undefined)) {
    throw badParam('pass exactly one of at ("HH:MM" local time) or resumeAt (RFC3339)');
  }

  const given = aliasParam('timeZone', 'time_zone', 'timezone');
  if (given !== undefined && !isValidTimeZone(given)) {
    throw badParam(`timeZone must be an IANA zone name such as "Asia/Shanghai", got ${JSON.stringify(given)}`);
  }
  const agentZone = agentTimeZone();
  if (given === undefined && agentZone && !isValidTimeZone(agentZone)) {
    throw badParam(`the Agent's TZ setting ${JSON.stringify(agentZone)} is not an IANA zone name; pass timeZone`);
  }
  const timeZone = canonicalTimeZone(given ?? (agentZone || 'UTC'));

  if (explicit !== undefined) {
    if (skipWeekend) throw badParam('skipWeekend applies only with at, not with resumeAt');
    if (typeof explicit !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(explicit)
      || !Number.isFinite(Date.parse(explicit))) {
      throw badParam(`resumeAt must be an RFC3339 time such as "2026-11-16T08:30:00+08:00", got ${JSON.stringify(explicit)}`);
    }
    return { issueId, dryRun, resumeAt: explicit, timeZone, tooClose: false };
  }

  const m = typeof at === 'string' ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at.trim()) : null;
  if (!m) throw badParam(`at must be a 24-hour local time "HH:MM" such as "08:30", got ${JSON.stringify(at)}`);
  const now = selfPauseNow();
  const instant = nextWallClockTime({ hour: Number(m[1]), minute: Number(m[2]), timeZone, now, skipWeekend });
  return {
    issueId, dryRun, resumeAt: new Date(instant).toISOString().replace(/\.000Z$/, 'Z'), timeZone,
    tooClose: instant - now < SELF_PAUSE_TOO_CLOSE_MS,
  };
}

/**
 * This Agent's own member id in `orgId`: the org's `self.member_id` from the
 * local config (written from the org JWT's claims at token exchange — the same
 * source comm-bridge and comm.js use), else `member_id` from `GET /me` with
 * that org's token (env-only deployments have no config entry). Never a
 * caller-supplied id: an Agent pauses only itself.
 */
async function selfMemberIdForOrg(orgId) {
  const configured = getOrgByOrgId(orgId)?.self?.member_id;
  if (configured) return configured;
  const me = await getForOrg(orgId, apiPath('/me'));
  if (me?.member_id) return me.member_id;
  throw Object.assign(new Error(`core.pause_self: cannot resolve this Agent's member id in org ${orgId} (no self.member_id in config and none from /me)`), { status: 400 });
}

/** {code, reason} when the error is a refusal the Agent reports, else null. */
function selfPauseRefusal(err) {
  const status = err?.status;
  if (!Number.isInteger(status) || status < 400 || status >= 500) return null;
  const env = (err.body?.error && typeof err.body.error === 'object') ? err.body.error : {};
  const code = typeof env.code === 'string' ? env.code : '';
  const detail = typeof env.detail === 'string' ? env.detail.trim() : '';
  if (code.startsWith('SELF_PAUSE_')) {
    return { code, reason: SELF_PAUSE_REASONS[code] || detail || 'the platform refused to pause the Agent' };
  }
  if (code) return null;
  // Billing refusals carry no code and Billing's reason as the detail, at the
  // status of Billing's answer: 409 for the known business refusals, else e.g.
  // 403 (permission denied), 404 (ADDON_NOT_FOUND) or 412.
  if (/^[A-Z][A-Z0-9_]+$/.test(detail)) {
    const fallback = status === 403 ? SELF_PAUSE_REASONS.PERMISSION_DENIED : `the platform refused to pause the Agent (${detail})`;
    return { code: detail, reason: SELF_PAUSE_REASONS[detail] || fallback };
  }
  // Billing's permission denial without a reason code carries its message as
  // the detail. (The platform's own authorization 403s carry a code.)
  if (status === 403) return { code: 'PERMISSION_DENIED', reason: SELF_PAUSE_REASONS.PERMISSION_DENIED };
  // A platform without the endpoint answers a plain 404.
  if (status === 404) return { code: 'SELF_PAUSE_UNAVAILABLE', reason: SELF_PAUSE_REASONS.SELF_PAUSE_UNAVAILABLE };
  return null;
}

function printSelfPauseRefusal(dryRun, code) {
  console.log(JSON.stringify({ ok: false, dry_run: dryRun, code, reason: SELF_PAUSE_REASONS[code], retryable: false }, null, 2));
  process.exit(1);
}

async function pauseSelf() {
  const { issueId, dryRun, resumeAt, timeZone, tooClose } = selfPauseRequest();
  const orgId = requireOrgId();
  if (tooClose) printSelfPauseRefusal(dryRun, 'SELF_PAUSE_TOO_CLOSE');
  const memberId = await selfMemberIdForOrg(orgId);
  let data;
  try {
    data = await postForOrg(orgId, apiPath(`/agents/${encodeURIComponent(memberId)}/runtime/self-pause`), {
      issue_id: issueId,
      resume_at: resumeAt,
      time_zone: timeZone,
      dry_run: dryRun,
    }, { retryOn401: false });
  } catch (err) {
    const refusal = selfPauseRefusal(err);
    if (!refusal) throw err;
    console.log(JSON.stringify({ ok: false, dry_run: dryRun, ...refusal, retryable: false }, null, 2));
    process.exit(1);
  }
  if (!data || typeof data !== 'object' || typeof data.status !== 'string' || !data.status) {
    throw new Error('core.pause_self: unexpected response from the platform (no status)');
  }
  // This run's pause was not confirmed (refused, cancelled first, or still
  // unconfirmed close to the resume time): the platform keeps that answer for
  // the run, and the Agent is not paused.
  if (data.status === 'not_paused') printSelfPauseRefusal(dryRun, 'SELF_PAUSE_NOT_PAUSED');
  const zone = isValidTimeZone(data.time_zone) ? data.time_zone : timeZone;
  const at = typeof data.resume_at === 'string' && data.resume_at ? data.resume_at : resumeAt;
  const local = describeLocalMinute(at, zone);
  return {
    ok: true,
    dry_run: dryRun,
    status: data.status,
    plan_id: data.plan_id ?? '',
    plan_status: typeof data.plan_status === 'string' ? data.plan_status : '',
    // false when the Agent is paused but no timed resume follows (a person
    // cancelled the plan meanwhile, or this run's plan is already settled);
    // null for a check.
    resume_scheduled: dryRun ? null : (typeof data.plan_status === 'string' && data.plan_status ? data.plan_status === 'pending' : true),
    issue_id: data.issue_id || issueId,
    resume_at: at,
    resume_local: local?.local ?? null,
    resume_weekday: local?.weekday ?? null,
    time_zone: zone,
    already: data.already === true,
  };
}

const COMMANDS = {
  // ✅ Current user / workspace identity
  'core.me': () => (params.org || params.orgId || params.org_id)
    ? oget(apiPath('/me')) : get(apiPath('/me')),

  // ✅ Self public base URL — resolve THIS agent's publicly-reachable base URL
  // for webhook-channel URL construction (WhatsApp Business / LINE / Teams).
  // Two-tier: (1) core service GET /platform-agents/{identity_id}/domain →
  // {ok,source:"core",full_domain,label,root_suffix,base_url}; (2) ONLY on a
  // core 404 fall back to AGENT_PUBLIC_BASE_URL → {ok,source:"env",base_url};
  // neither → {ok:false,error} + exit 1. Non-404 errors and malformed 200s
  // (no identity_id / full_domain) fail loudly (stderr, exit 1) instead of
  // falling back to env. See src/lib/agent-domain.js.
  'core.agent_domain': () => agentDomainCommand(),

  // ✅ Rename self (display name). Updates the core service identity via PATCH /me
  // (works for org-member agents — no admin needed) AND mirrors the new
  // name into local config's per-org `self.name`. See selfRename() above.
  'core.self_rename': () => selfRename(params.name || params.displayName || params.display_name),

  // Pause THIS Agent after its automation run; the platform resumes it at
  // the given time. POST /agents/{own member_id}/runtime/self-pause, org-scoped,
  // no 401 replay. dryRun:true checks only; without it pauses (the platform
  // refuses until the run's result is delivered). Refusals print
  // {ok:false,dry_run,code,reason,retryable:false} on stdout + exit 1; 5xx and
  // network errors take the normal error path (safe to retry the same call).
  // A Core without the endpoint answers 404 → SELF_PAUSE_UNAVAILABLE.
  // See pauseSelf() above and references/automation-delivery.md.
  'core.pause_self': () => pauseSelf(),

  // ✅ Members directory.
  // The backend uses PageParams (envelope.go) — `page` + `page_size`, NOT cursor/limit.
  // Legacy callers passing `limit` continue to work via the alias.
  'core.member_list': () => oget(apiPath('/members'), {
    kind:      params.kind || params.type,
    status:    params.status,
    search:    params.search || params.q,
    page:      params.page,
    page_size: params.pageSize ?? params.limit,
    order_by:  params.orderBy,
  }),
  'core.member_get': () => oget(apiPath(`/members/${params.memberId}`)),

  // ✅ Project member list
  'core.project_members': () => oget(apiPath(`/projects/${params.projectId}/members`), projectMemberPageQuery()),

  // ✅ Agent capability profiles — the backend BFF aggregation a Lead reads to
  // pick a candidate agent for dispatch. A scope is REQUIRED: pass projectId
  // (resolved to the project's agents via cws-work) and/or memberIds
  // (repeatable agent member IDs). `include:["capabilities"]` (or the
  // `capabilities:true` shorthand) loads skills (agent self-reported) + tags
  // (human-declared); omit for the lightweight view. online_status is always
  // enriched. Open-ended org-wide capability search is intentionally NOT here.
  'core.agent_profiles': () => oget(apiPath('/agent-profiles'), {
    project_id: params.projectId || params.project_id,
    member_id:  toArray(params.memberIds ?? params.memberId ?? params.member_id),
    include:    params.capabilities
      ? Array.from(new Set([...toArray(params.include), 'capabilities']))
      : toArray(params.include),
  }),

  // ✅ Platform agents — agent member lifecycle.
  // DELETE /api/v1/platform-agents/{member_id}
  // Creating a platform-hosted agent is intentionally NOT exposed here: it is
  // billed and org-owner-only on the backend (OPENM-1069).
  'core.platform_agent_delete': () => odel(apiPath(`/platform-agents/${params.memberId}`)),

  // ✅ Onboarding session — the calling Agent's own onboarding record
  // (scope:"agent"): owner, preset role (role_key / role_custom), org industry
  // (omitted when unset), user_has_im_channel / owner_is_org_admin (omitted =
  // unknown), and `events` [{event_type, occurred_at, agent_member_id?, meta?}]
  // — the push records the Agent checks before sending any onboarding card.
  // 404 = no onboarding for this Agent. See references/onboarding-lead.md.
  'core.onboarding_session': () => oget(apiPath('/onboarding/session')),

  // ✅ Onboarding preset — default name / persona / the three opening task
  // cards (title + prompt, zh + en) for one (role, industry). Only the ops role
  // uses the industry; unknown input falls back server-side (never fails).
  'core.onboarding_preset': () => getForOrgWithHeaders(requireOrgId(), apiPath('/onboarding/employee-preset'), onboardingLangHeaders(), {
    role:     params.role || params.roleKey || params.role_key,
    industry: params.industry,
  }),

  // ✅ Onboarding profile options — option lists incl. `im_channels`. The IM
  // card's channel order is chosen by the Agent's own TZ (Asia/Shanghai or
  // Asia/Urumqi → cn, else intl) and requested with `imOrder` (?im_order=);
  // `lang` (zh|en) sets the label language via Accept-Language;
  // without it the server falls back to edition / geo. Any other value is a
  // server-side 400. See references/onboarding-lead.md.
  'core.onboarding_profile_options': () => getForOrgWithHeaders(requireOrgId(), apiPath('/onboarding/profile-options'), onboardingLangHeaders(), {
    im_order: params.imOrder || params.im_order,
  }),

  // ✅ Onboarding event report. Self-reportable types: d1_activation (owner's
  // first message in the onboarding DM), d3_im_connected (IM channel linked),
  // and the push records task_cards_sent / im_card_sent / im_card_second_sent /
  // im_card_declined / partner_card_sent. Duplicates are absorbed server-side
  // (idempotent 200, recorded=false) — safe to fire without checking first.
  // im_card_sent / im_card_second_sent / partner_card_sent are claims: report
  // BEFORE sending the card and send only when the response says
  // recorded=true (exactly one of concurrent claimants gets it); the response
  // `{event_type, recorded}` is printed unchanged for that decision.
  // d7_first_delivery is server-observed and cannot be self-reported.
  'core.onboarding_event': () => opost(apiPath('/onboarding/events'), {
    event_type:  params.eventType || params.event_type,
    occurred_at: params.occurredAt || params.occurred_at,
    meta:        params.meta,
  }),

  // ✅ Projects list. Defaults to active projects: resolving a project by name
  // (e.g. picking where to register an Issue) must not match ARCHIVED ones — a
  // human refers to a live project, and archived duplicates would make the match
  // ambiguous. Pass status:"archived" explicitly to list archived projects.
  // The backend uses PageParams — `page` + `page_size`, NOT cursor/limit.
  'core.project_list': () => oget(apiPath('/projects'), {
    status:    params.status ?? 'active',
    page:      params.page,
    page_size: params.pageSize ?? params.limit,
    order_by:  params.orderBy,
  }),

  // ✅ Organizations.
  'core.org_list':   () => get(apiPath('/organizations'), {
    order_by: params.orderBy,
  }),
  'core.org_get':    () => oget(apiPath(`/organizations/${params.orgId}`)),
  // POST /api/v1/organizations  — create a new org and become its owner.
  // Server requires {name, slug, display_name}: display_name is the
  // caller's display name *within the new org* (the caller is auto-added
  // as org-owner member, and that membership row needs a display_name).
  // Response includes a fresh `access_token` already scoped to the new
  // org's `member_id`, so callers can immediately act in the new context
  // without a separate `org_switch`.
  'core.org_create': () => post(apiPath('/organizations'), {
    name: params.name,
    slug: params.slug,
    display_name: params.displayName || params.display_name,
  }),
  // POST /api/v1/organizations/{org_id}/switch  — swap principal's active org.
  // Server requires a body to be present (empty `{}` is fine; any
  // additional property is rejected as `unexpected property` 422 — the
  // request schema is closed). Returns a fresh `access_token` scoped to
  // the target org (used by callers that need to act under the new org
  // context immediately).
  'core.org_switch': () => post(apiPath(`/organizations/${params.orgId}/switch`), {}),

  // ✅ Roles
  'core.role_list': () => oget(apiPath('/roles'), { scope: params.scope }),

  // ✅ Invitations
  // POST /api/v1/invitations — body {email?, display_name, role_id, message?}
  //   org_id is resolved server-side from the caller's JWT — do NOT send it.
  //   `display_name` (the invitee's org-level member name) is REQUIRED: naming
  //   happens at create-time — the name is stored on the invitation and becomes
  //   members.display_name on accept. Server rejects a blank display_name with
  //   400. Accept either camel or snake.
  'core.invitation_create': () => opost(apiPath('/invitations'), {
    email:        params.email,
    display_name: params.displayName ?? params.display_name,
    role_id:      params.roleId,
    message:      params.message,
  }),
  // GET /api/v1/invitations — query {status?, page?, page_size?, order_by?}
  //   org_id is resolved server-side from the caller's JWT — do NOT send it.
  //   The backend uses PageParams — `page` + `page_size`, NOT cursor/limit.
  'core.invitation_list': () => oget(apiPath('/invitations'), {
    status:    params.status,
    page:      params.page,
    page_size: params.pageSize ?? params.limit,
    order_by:  params.orderBy,
  }),
  // POST /api/v1/invitations/{invitation_id}/accept
  // Body is just `{token}`: the invitee display name now comes from the
  // invitation (set at create time), so accept no longer takes display_name —
  // sending it would be schema-invalid.
  'core.invitation_accept': () => post(apiPath(`/invitations/${params.invitationId}/accept`), {
    token: params.token,
  }),
  // DELETE /api/v1/invitations/{invitation_id}
  'core.invitation_revoke': () => odel(apiPath(`/invitations/${params.invitationId}`)),

  // Local helper — build a browser-navigable frontend URL. Not an API call.
  // Uses server.frontend_base_path (default /cws) + bff_url origin.
  'core.frontend_url': () => {
    const p = params.path || params.p || '';
    if (!p) throw Object.assign(new Error('path is required'), { status: 400 });
    return { url: frontendUrl(p) };
  },
};

function printUsage() {
  console.log(`Core CLI — directory queries on cws-core (contract-v5)

Usage: node src/cli/core.js <command> '<json-params>'

Identity
  core.me                  {}
  core.self_rename         {name}    # change own display_name (cws-core /me + local config self.name)
  core.agent_domain        {}        # resolve own public base_url for webhook channels
                           # (1) cws-core bound domain → base_url=https://<full_domain>
                           # (2) AGENT_PUBLIC_BASE_URL env, ONLY on core 404 (no bound domain)
                           # neither → {ok:false} exit 1; other errors/malformed 200 → stderr exit 1

Automation runs (see references/automation-delivery.md "Pausing yourself after the run")
  core.pause_self          {issueId, at | resumeAt, skipWeekend?, timeZone?, dryRun?}
                           # pause THIS Agent after its automation run; the platform resumes it at that time
                           # at:"HH:MM" → the next such time in timeZone (default: Agent TZ, else UTC); refused
                           #   locally (SELF_PAUSE_TOO_CLOSE) when less than 30 minutes away;
                           #   skipWeekend:true moves a Saturday/Sunday date to Monday; resumeAt: RFC3339, used as is
                           # dryRun:true = check only; without it = pause (refused until the run result is delivered);
                           #   the pause and any retry pass resumeAt = the check's resume_at, never at again
                           # → {ok:true,status,resume_at,resume_local,resume_weekday,...}
                           # refused → stdout {ok:false,dry_run,code,reason,retryable:false} exit 1; 5xx → stderr, retry same call

Members (humans + agents in one directory)
  core.member_list         {kind?, status?, search?, page?, pageSize?, orderBy?}
                           # kind: human|agent|all (legacy alias: type)
                           # search legacy alias: q;  pageSize legacy alias: limit
  core.member_get          {memberId}
  core.project_members     {projectId, page?, pageSize?}  # pageSize legacy alias: limit
  core.agent_profiles      {projectId?, memberIds?, include?, capabilities?}
                           # agent 能力画像聚合（派发前选候选）。scope 必填：projectId 和/或 memberIds(可数组)
                           # capabilities:true 或 include:["capabilities"] → 含 skills(自报)+tags(人工标注)；不带则轻量视图

Platform agents (lifecycle)
  core.platform_agent_delete  {memberId}

Projects (directory view — workflow ops live in tm.js)
  core.project_list        {status?, page?, pageSize?, orderBy?}    # default status=active (pass status:"archived" for archived); pageSize legacy alias: limit

Onboarding (see SKILL.md "Onboarding Lead" → references/onboarding-lead.md)
  core.onboarding_session  {}                                  # 本 Agent 的引导记录：岗位、行业、用户是否已接 IM、已记录的推送节点；404=无引导
  core.onboarding_preset   {role, industry?, lang?}            # 按岗位（运营按行业）取 3 张开场任务卡 + 人设
  core.onboarding_profile_options {imOrder?, lang?}            # 选项表；imOrder=cn|intl 指定 im_channels 顺序（按本 Agent 时区选，见 onboarding-lead）
  core.onboarding_event    {eventType, occurredAt?, meta?}     # 上报：d1_activation|d3_im_connected|task_cards_sent|im_card_sent|im_card_second_sent|im_card_declined|partner_card_sent；重复上报幂等（recorded=false）；im_card_sent/im_card_second_sent/partner_card_sent 为发送前认领：先报，recorded=true 才发卡

Organizations
  core.org_list            {orderBy?}
  core.org_get             {orgId}
  core.org_create          {name, slug, displayName}  # creates org + auto-becomes org-owner; returns access_token scoped to new org
  core.org_switch          {orgId}      # principal's active org swap — returns new access_token scoped to target org

Roles
  core.role_list           {scope?}

Invitations
  core.invitation_create   {roleId, displayName, email?, message?}   # displayName REQUIRED (invitee's org member name); accepts display_name
  core.invitation_list     {status?, page?, pageSize?, orderBy?}    # pageSize legacy alias: limit
  core.invitation_accept   {invitationId, token}                    # no display_name — name comes from the invitation
  core.invitation_revoke   {invitationId}

Helpers
  core.frontend_url        {path}   # build browser-navigable URL: bff_url + frontend_base_path + path
                           # e.g. {path:"/knowledge?kb=xxx&node=yyy"} → https://<bff-host>/cws/knowledge?...

Environment:
  COCO_API_URL       cws-core base URL (default: http://127.0.0.1:8080)
  COCO_API_PREFIX    Path prefix override (default: /api/v1)
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  try {
    const result = await handler();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    const fieldErrors = err.body?.error?.errors;
    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) payload.errors = fieldErrors;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
