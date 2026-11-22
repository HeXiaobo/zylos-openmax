#!/usr/bin/env node

/**
 * Task Management CLI.
 *
 * Thin stateless wrapper over cws-core's task/project/issue surface, aligned
 * to the `contract-v2` tag of cws-core (which proxies all TM RPCs to
 * cws-work). See `docs/dependency-coverage/cws-tm.md` for the per-endpoint
 * mapping and Findings table.
 *
 * Usage:
 *   node src/cli/tm.js <command> '<json-params>'
 *   node src/cli/tm.js project.create '{"name":"Growth","slug":"growth","leadMemberId":"..."}'
 *
 * All exposed commands are backed by an existing cws-core@contract-v2
 * forwarding endpoint — there are no placeholder / ⏳ entries anymore. The
 * earlier ⏳ batch (blueprint fine-grained ops + taskboard.list) was removed
 * because cws-core does not yet proxy them; re-add when forwarding ships.
 *
 * Pagination convention:
 *   - User-facing camelCase: page, pageSize, orderBy
 *   - Wire snake_case:       page, page_size, order_by
 *   - Most list endpoints use offset paging via {page, page_size}.
 *   - Comment list follows its backend contract and uses {cursor, limit}.
 */

import { getForOrg, postForOrg, patchForOrg, putForOrg, delForOrg, apiPath } from '../lib/client.js';
import { resolveDefaultOrgId } from '../lib/config.js';
import { automationAuthorizationPreview, automationAuthorizationProposal, automationMutation } from '../lib/automation-configuration.js';

const [command, ...rest] = process.argv.slice(2);
// pause / resume / run report an unparseable argument as INVALID_PARAMS with
// sent:false (automationOpBody), so an Agent never mistakes it for an unknown
// outcome. Every other command keeps throwing the SyntaxError here, as before.
const AUTOMATION_OP_COMMANDS = new Set(['event-binding.pause', 'event-binding.resume', 'event-binding.run']);
let params = {};
let paramsError = null;
if (rest.length) {
  try {
    params = JSON.parse(rest.join(' '));
  } catch (err) {
    if (!AUTOMATION_OP_COMMANDS.has(command)) throw err;
    paramsError = err;
  }
}

// Org resolution (mirrors conn.js PR#127). Every TM route — projects, issues,
// tasks, comments, blueprints, attempts, event-bindings — is org-owned: the backend
// resolves the org from the JWT principal and 403s ("org membership required")
// on an identity-only token. A bare get()/post() would silently fall through to
// resolveDefaultOrgId(), which returns '' when >1 org is enabled and no org is
// given — producing that opaque 403. Resolve the operating org (explicit {org}
// or the single enabled org) and FAIL FAST with an actionable 400 when it can't
// be determined. Single-org / COCO_ORG_ID deployments resolve exactly as before.
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

// Org-scoped shadows of the bare verbs: each call carries the operating org's
// JWT. Resolved lazily per call so `help` / usage never require an org.
const get   = (path, query) => getForOrg(requireOrgId(), path, query);
const post  = (path, body, options) => postForOrg(requireOrgId(), path, body, options);
const patch = (path, body)  => patchForOrg(requireOrgId(), path, body);
const put   = (path, body, options) => putForOrg(requireOrgId(), path, body, options);
const del   = (path)        => delForOrg(requireOrgId(), path);

// Build the standard PageParams query block from user-supplied camelCase.
function pageParams(p) {
  return {
    page:      p.page,
    page_size: p.pageSize,
    order_by:  p.orderBy,
  };
}

function cursorParams(p) {
  return {
    cursor:   p.cursor,
    limit:    p.limit,
    order_by: p.orderBy,
  };
}

// The Issue list endpoints exclude automation-run Issues unless
// include_automation=true; send it only when explicitly requested so the
// default request is unchanged. Anything other than a JSON boolean is
// rejected before the request: silently dropping "true" or 1 would return
// the default list, which excludes exactly the Issues that were asked for.
function issueListParams(p) {
  if (Object.hasOwn(p, 'includeAutomation') && typeof p.includeAutomation !== 'boolean') {
    throw new Error(`${command} includeAutomation must be true or false (a JSON boolean), got ${JSON.stringify(p.includeAutomation)}`);
  }
  return {
    status:             p.status,
    statuses:           p.statuses,
    priority:           p.priority,
    include_archived:   p.includeArchived,
    include_automation: p.includeAutomation === true ? true : undefined,
    query:              p.query,
    ...pageParams(p),
  };
}

function requireParams(commandName, names) {
  const missing = names.filter((name) => params[name] == null || params[name] === '');
  if (missing.length > 0) {
    throw new Error(`${commandName} requires ${missing.join(', ')}`);
  }
}

function requireTextParams(commandName, names) {
  const invalid = names.filter(name => typeof params[name] !== 'string' || !params[name].trim());
  if (invalid.length) throw new Error(`${commandName} requires non-empty text: ${invalid.join(', ')}`);
}

// ── Pause / resume / run once an existing automation (OPENM-1376) ──────────
// Thin calls to POST /event-bindings/{id}/pause|resume|run. Work decides who
// may: an Agent caller must be the binding's Lead (a person on the web, its
// Owner; admins have no bypass), and expected_version must be the current
// version. That the person asking is the Owner is the Agent's own check before
// calling (references/automation-operate.md). None of the three bodies takes a
// note, reason or actor field, so none is sent.

// The stderr error tells three outcomes apart. Bad parameters, found before
// any request: {code:"INVALID_PARAMS", sent:false} — nothing was sent. A
// refusal from the platform: {code, reason, refused:true}. A transient failure
// (5xx, timeout, network, 401/408/429): neither, so the outcome is unknown.
const AUTOMATION_OP_REASONS = {
  INVALID_PARAMS: 'the parameters are invalid and nothing was sent; fix them (expected_version from a fresh event-binding.get) instead of retrying',
  NOT_FOUND: 'the automation does not exist or this Agent cannot see it',
  NOT_LEAD: "this Agent is not the automation's responsible Agent (Lead), so it may not operate it",
  VERSION_CONFLICT: 'the automation changed after it was read; read it again and retry once only if the change is still needed',
  CONFIRM_PAUSED_REQUIRED: 'the automation is paused; running it once needs the requester to confirm a run while paused (confirm_paused)',
  RUN_NOT_ALLOWED: 'the automation needs attention, has ended or was replaced; it has to be fixed or rescheduled first',
  ORG_SUSPENDED: 'the organization is suspended; automations cannot run until it is restored',
  UNSUPPORTED_SOURCE_KIND: 'only a scheduled (timer) automation can be run on demand; a webhook automation runs when its event arrives',
  NO_NEXT_TRIGGER: 'the schedule has no future trigger time (for example a one-time run whose time has passed); the schedule has to be changed first',
  LEAD_PROJECT_ACCESS_REQUIRED: "the responsible Agent is no longer a member of the automation's project",
  OWNER_PROJECT_ACCESS_REQUIRED: "the automation's Owner is no longer a member of its project",
  MEMBER_UNAVAILABLE: "the automation's responsible Agent or Owner has left the organization",
  PRIVATE_LEAD_OWNER_CHANGED: "the responsible Agent no longer belongs to the private automation's Owner",
  PROJECT_UNAVAILABLE: "the automation's project is archived or unavailable",
  REFUSED: 'the platform refused the request',
};

// Core codes (cws-work codes re-mapped by cws-core) that name the refusal.
const AUTOMATION_OP_CODES = {
  WORK_EVENT_BINDING_NOT_FOUND: 'NOT_FOUND',
  WORK_EVENT_BINDING_VERSION_CONFLICT: 'VERSION_CONFLICT',
  AUTOMATION_ORG_SUSPENDED: 'ORG_SUSPENDED',
  WORK_EVENT_BINDING_LEAD_PROJECT_ACCESS_REQUIRED: 'LEAD_PROJECT_ACCESS_REQUIRED',
  WORK_OWNER_PROJECT_ACCESS_REQUIRED: 'OWNER_PROJECT_ACCESS_REQUIRED',
  WORK_MEMBER_DEPARTED: 'MEMBER_UNAVAILABLE',
  AUTOMATION_PRIVATE_LEAD_NOT_OWNED: 'PRIVATE_LEAD_OWNER_CHANGED',
  WORK_PROJECT_ALREADY_ARCHIVED: 'PROJECT_UNAVAILABLE',
};

// The rest arrive as Core's generic WORK_ERROR; the status and Work's message
// tell them apart. On these three routes the only 403 without a specific code
// is Work's Lead check ("an agent may only manage its own event binding").
const AUTOMATION_OP_GENERIC = [
  [403, /^/, 'NOT_LEAD'],
  [404, /project not found/i, 'PROJECT_UNAVAILABLE'],
  [412, /requires confirmation to run once/i, 'CONFIRM_PAUSED_REQUIRED'],
  [412, /repaired or rescheduled/i, 'RUN_NOT_ALLOWED'],
  [400, /only timer source kind/i, 'UNSUPPORTED_SOURCE_KIND'],
  [400, /invalid timer schedule/i, 'NO_NEXT_TRIGGER'],
];

function automationOpRefusal(err) {
  const status = err?.status;
  if (!Number.isInteger(status) || status < 400 || status >= 500 || [401, 408, 429].includes(status)) return null;
  const env = (err.body?.error && typeof err.body.error === 'object') ? err.body.error : {};
  const platformCode = typeof env.code === 'string' ? env.code : '';
  const detail = typeof env.detail === 'string' ? env.detail : '';
  let code = AUTOMATION_OP_CODES[platformCode];
  if (!code && platformCode === 'WORK_ERROR') {
    code = AUTOMATION_OP_GENERIC.find(([s, pattern]) => s === status && pattern.test(detail))?.[2];
  }
  code ||= 'REFUSED';
  return { code, reason: AUTOMATION_OP_REASONS[code], refused: true, ...(platformCode ? { platform_code: platformCode } : {}) };
}

/** Validate before any request; returns the exact request body. */
function automationOpBody(commandName, { run = false } = {}) {
  const bad = (msg) => Object.assign(new Error(`${commandName} ${msg}`), { status: 400 });
  if (paramsError) throw bad(`requires its parameters as one JSON object; the argument is not valid JSON (${paramsError.message})`);
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw bad(`requires its parameters as one JSON object, got ${Array.isArray(params) ? 'an array' : JSON.stringify(params)}`);
  }
  requireTextParams(commandName, ['org', 'id']);
  const version = params.expected_version;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw bad('requires expected_version: the positive integer version from the latest event-binding.get');
  }
  if (!run) return { expected_version: version };
  const key = params.idempotency_key;
  if (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key, 'utf8') > 128
    || key.includes('\0') || !key.isWellFormed()) {
    throw bad('requires idempotency_key: non-empty text of at most 128 bytes, the same for every retry of one confirmed run (e.g. "chat-run:<confirmation card message id>")');
  }
  if (params.confirm_paused !== undefined && typeof params.confirm_paused !== 'boolean') {
    throw bad(`confirm_paused must be true or false (a JSON boolean), got ${JSON.stringify(params.confirm_paused)}`);
  }
  return { expected_version: version, idempotency_key: key, ...(params.confirm_paused === true ? { confirm_paused: true } : {}) };
}

// err.report holds the fields main() adds to the stderr error. Only a failure
// of the local validation (before any request) is INVALID_PARAMS/sent:false; an
// answer from the server, a 400 included, goes through automationOpRefusal.
async function automationOperation(commandName, action, options) {
  let body;
  try {
    body = automationOpBody(commandName, options);
  } catch (err) {
    err.status ??= 400;
    err.report = { code: 'INVALID_PARAMS', reason: AUTOMATION_OP_REASONS.INVALID_PARAMS, sent: false };
    throw err;
  }
  try {
    return await post(apiPath(`/event-bindings/${encodeURIComponent(params.id)}/${action}`), body, { retryOn401: false });
  } catch (err) {
    const refusal = automationOpRefusal(err);
    if (refusal) err.report = refusal;
    throw err;
  }
}

const COMMANDS = {
  // =========================================================================
  //  PROJECT
  // =========================================================================

  'project.list': () => get(apiPath('/projects'), {
    status: params.status,       // enum: active|archived
    query:  params.query,
    ...pageParams(params),
  }),

  // contract-v2 create-project body: { name*, description?, slug*,
  // is_default, lead_member_id*, knowledge_base_id?, member_ids? }
  'project.create': () => post(apiPath('/projects'), {
    name:               params.name,
    description:        params.description,
    slug:               params.slug,
    is_default:         params.isDefault,
    lead_member_id:     params.leadMemberId,
    knowledge_base_id:  params.knowledgeBaseId,
    member_ids:         params.memberIds,
  }),

  'project.get': () => get(apiPath(`/projects/${params.id}`)),

  // Omitted fields preserve their current values, including the default KB.
  'project.update': () => patch(apiPath(`/projects/${params.id}`), {
    name:               params.name,
    description:        params.description,
    lead_member_id:     params.leadMemberId,
    knowledge_base_id:  params.knowledgeBaseId,
  }),

  'project.archive':   () => post(apiPath(`/projects/${params.id}/archive`)),

  'project.members': () => get(
    apiPath(`/projects/${params.id}/members`),
    pageParams(params),
  ),

  'project.member_add': () => post(apiPath(`/projects/${params.id}/members`), {
    member_id: params.memberId,
    role:      params.role ?? 'member',
  }),

  'project.member_remove': () => del(
    apiPath(`/projects/${params.id}/members/${params.memberId}`),
  ),

  // =========================================================================
  //  ISSUE  (✅ all cws-core BFF issue commands — note issue write paths
  //  use the FLAT path /issues/{id}, not /projects/{pid}/issues/{id})
  // =========================================================================

  'issue.list': () => get(apiPath('/issues'), issueListParams(params)),

  'issue.list_in_project': () => get(
    apiPath(`/projects/${params.projectId}/issues`),
    issueListParams(params),
  ),

  // Flat path, no project prefix.
  'issue.get': () => get(apiPath(`/issues/${params.id}`)),

  // create-issue body: requires title*, lead_agent_id*, owner_member_id*;
  // optional priority (default medium), origin_conversation_id,
  // origin_message_id, backlog. Context for the work goes in description
  // (natural language) and later in task comments — not in id lists.
  'issue.create': () => {
    requireParams('issue.create', ['projectId', 'title', 'leadAgentId', 'ownerMemberId']);
    return post(apiPath(`/projects/${params.projectId}/issues`), {
      title:                  params.title,
      description:            params.description || '',
      backlog:                params.backlog,
      priority:               params.priority,              // low|medium|high (optional, default medium)
      lead_agent_id:          params.leadAgentId,
      owner_member_id:        params.ownerMemberId,
      origin_conversation_id: params.originConversationId,
      origin_message_id:      params.originMessageId,
    });
  },

  // Flat path; body: { title?, description?, priority? }.
  'issue.update': () => patch(
    apiPath(`/issues/${params.id}`),
    {
      title:              params.title,
      description:        params.description,
      priority:           params.priority,
    },
  ),

  // Semantic issue lifecycle actions (cws-core BFF). The generic
  // POST /issues/{id}/transition endpoint was removed; each state change is
  // now its own endpoint that enforces invariants and side effects.
  'issue.activate': () => post(
    apiPath(`/issues/${params.id}/activate`),
    { source: params.source ?? 'lead_chat' },
  ),
  'issue.submit_plan': () => {
    if (!params.blueprintId) {
      throw new Error('issue.submit_plan requires blueprintId; create a one-step Blueprint for simple tasks');
    }
    return post(
      apiPath(`/issues/${params.id}/submit-plan`),
      {
        plan_text:       params.planText ?? params.plan,
        blueprint_id:    params.blueprintId,
        source:          params.source ?? 'lead_chat',
        card_message_id: params.cardMessageId,
      },
    );
  },
  // Temporary text-card simulation: when a human replies "接受计划", Lead may
  // proxy that card click with source=text_card_proxy. Real interactive cards
  // should call the same endpoint as the human principal.
  'issue.accept_plan': () => post(
    apiPath(`/issues/${params.id}/accept-plan`),
    { source: params.source ?? 'text_card_proxy' },
  ),
  'issue.deliver': () => {
    requireParams('issue.deliver', ['id']);
    const structured = ['summary', 'outcome', 'artifacts', 'idempotencyKey'].some(key => Object.hasOwn(params, key));
    if (!structured) return post(apiPath(`/issues/${params.id}/deliver`));
    requireTextParams('issue.deliver', ['summary', 'outcome', 'idempotencyKey']);
    if (!['success', 'partial', 'failed'].includes(params.outcome)) {
      throw new Error('issue.deliver outcome must be success, partial, or failed');
    }
    const artifacts = params.artifacts ?? [];
    if (!Array.isArray(artifacts) || artifacts.some(item => !item || typeof item.title !== 'string' || !item.title.trim() || typeof item.url !== 'string' || !item.url.trim())) {
      throw new Error('issue.deliver artifacts must be an array of {title, url}');
    }
    return post(apiPath(`/issues/${params.id}/deliver`), {
      summary: params.summary,
      outcome: params.outcome,
      artifacts: artifacts.map(({ title, url }) => ({ title, url })),
      idempotency_key: params.idempotencyKey,
    }, { retryOn401: false });
  },
  'issue.create_revision': () => {
    requireTextParams('issue.create_revision', ['id', 'description', 'originMessageId', 'idempotencyKey']);
    return post(apiPath(`/issues/${params.id}/revisions`), {
      description: params.description,
      origin_message_id: params.originMessageId,
      idempotency_key: params.idempotencyKey,
    }, { retryOn401: false });
  },
  'issue.resume':          () => post(
    apiPath(`/issues/${params.id}/resume`),
    {
      reason: params.reason ?? params.feedback,
      source: params.source ?? 'lead_chat',
    },
  ),
  // Temporary text-card simulation: only after the Owner explicitly accepts
  // the delivery may the Lead proxy that acceptance with text_card_proxy.
  'issue.accept_delivered': () => post(
    apiPath(`/issues/${params.id}/accept-delivered`),
    { source: params.source ?? 'text_card_proxy' },
  ),

  // Body field is new_owner_member_id (mirrors task.reassign pattern).
  'issue.reassign_owner': () => post(
    apiPath(`/issues/${params.id}/reassign-owner`),
    { new_owner_member_id: params.ownerMemberId ?? params.newOwnerMemberId },
  ),

  // Flat path; body field is `new_project_id` (not `project_id`).
  'issue.move_project': () => post(
    apiPath(`/issues/${params.id}/move`),
    { new_project_id: params.targetProjectId ?? params.newProjectId },
  ),

  // 提前终止(v0.7): 把一个未结论 Issue 主动停下 → terminated。服务端会级联
  // 取消其下非终态 Task,并给 Lead 发 issue.terminated 事件做善后。
  // 不回滚已发生副作用——善后由 Lead 与人类共同决定(见 SKILL.md)。
  // POST /issues/{id}/terminate, body: { reason?, source? }
  'issue.terminate': () => post(
    apiPath(`/issues/${params.id}/terminate`),
    {
      reason: params.reason,
      source: params.source ?? 'lead_chat',
    },
  ),

  // =========================================================================
  //  TASK  (✅ all 8 on cws-core BFF; create uses the doubly-nested path
  //  /projects/{pid}/issues/{iid}/tasks. v0.7 claim/start split: claim only
  //  assigns, task.start begins work + opens the attempt + checks dependsOn.)
  // =========================================================================

  'task.list': () => get(apiPath('/tasks'), {
    project_id:       params.projectId,
    issue_id:         params.issueId,
    status:           params.status,           // pending|assigned|running|done|failed|cancelled
    include_archived: params.includeArchived,
    ...pageParams(params),
  }),

  'task.get': () => get(apiPath(`/tasks/${params.id}`)),

  // create-task path: /projects/{pid}/issues/{iid}/tasks
  // body: { title*, description?, assignee_id?, blueprint_step_id?, depends_on? }
  // (priority / status are NOT accepted — those live on issue.)
  // depends_on entries MUST be upstream Task ids (task.id). What a task needs
  // goes in description (natural language); upstream deliverables arrive via the
  // upstream task's comments, not a context id list.
  'task.create': () => post(
    apiPath(`/projects/${params.projectId}/issues/${params.issueId}/tasks`),
    {
      title:              params.title,
      description:        params.description || '',
      assignee_id:        params.assigneeId,
      blueprint_step_id:  params.blueprintStepId,
      depends_on:         params.dependsOn,
    },
  ),

  // v0.7 claim/start split: claim ONLY assigns the task to the caller
  // (pending → assigned). It does NOT start work or open an attempt — call
  // task.start next. POST /tasks/{id}/claim (no body; principal from auth header).
  'task.claim': () => post(apiPath(`/tasks/${params.id}/claim`)),

  // v0.7: start an assigned task (assigned → running) and open the attempt.
  // The dependency gate (depends_on all done) is enforced here, not at claim.
  // POST /tasks/{id}/start (no body; principal from auth header).
  'task.start': () => post(apiPath(`/tasks/${params.id}/start`)),

  // Path is /transition (not /status); body field is target_status.
  'task.transition': () => post(
    apiPath(`/tasks/${params.id}/transition`),
    { target_status: params.status ?? params.targetStatus },
  ),
  // Backward-compat alias for older scripts.
  'task.status': () => post(
    apiPath(`/tasks/${params.id}/transition`),
    { target_status: params.status ?? params.targetStatus },
  ),

  // Body field is new_assignee_id (not assignee_id).
  'task.reassign': () => post(
    apiPath(`/tasks/${params.id}/reassign`),
    { new_assignee_id: params.assigneeId ?? params.newAssigneeId },
  ),

  // =========================================================================
  //  COMMENT  (issue/task discussion + the agent-to-agent handoff channel.
  //  A worker writes a completion comment on its task — natural-language
  //  deliverable address/summary — when finishing; the next assignee reads the
  //  upstream task's comments to pick up context. Author is derived from the
  //  auth principal; body is markdown.)
  // =========================================================================

  // body: { work_type ('issue'|'task'), work_id, body_markdown }
  'comment.create': () => post(apiPath('/comments'), {
    work_type:     params.workType,
    work_id:       params.workId,
    body_markdown: params.bodyMarkdown ?? params.body,
  }),

  // Each comment is addressable: GET /comments/{id}.
  'comment.get': () => get(apiPath(`/comments/${params.id}`)),

  // List a work item's comments (time-ordered). Requires workType + workId.
  'comment.list': () => get(apiPath('/comments'), {
    work_type: params.workType,
    work_id:   params.workId,
    ...cursorParams(params),
  }),

  // =========================================================================
  //  BLUEPRINT  (✅ all 4 in contract-v2 — create / get / list / set-steps;
  //  blueprint.create and .list are issue-nested; blueprint.set_steps is
  //  PUT-and-replace, not POST-and-append.)
  // =========================================================================

  // contract-v2 create-blueprint:
  //   POST /api/v1/issues/{issue_id}/blueprints
  //   body: { steps[]*, estimated_budget?, notes? }
  // where each step is { temp_id, description, required_resources?,
  //                     depends_on_temp_ids? }.
  //
  // NOTE: cws-core derives author_agent_id from the auth principal; it is not
  // a request field and must not be forwarded.
  'blueprint.create': () => post(
    apiPath(`/issues/${params.issueId}/blueprints`),
    {
      steps:            params.steps,
      estimated_budget: params.estimatedBudget,
      notes:            params.notes,
    },
  ),

  'blueprint.get': () => get(
    apiPath(`/blueprints/${params.id}`),
    { include_steps: params.includeSteps },
  ),

  // contract-v2 path: GET /api/v1/issues/{issue_id}/blueprints (path-scoped,
  // not query-scoped).
  'blueprint.list': () => get(
    apiPath(`/issues/${params.issueId}/blueprints`),
    pageParams(params),
  ),

  // contract-v2 set-blueprint-steps: PUT (replace all). Replaces the legacy
  // tm.js `blueprint.add_step` which assumed POST-and-append semantics —
  // that surface does not exist in contract-v2.
  'blueprint.set_steps': () => put(
    apiPath(`/blueprints/${params.blueprintId ?? params.id}/steps`),
    { steps: params.steps },
  ),

  // =========================================================================
  //  ATTEMPT  (contract-v2: create / get / list / transition)
  // =========================================================================

  // contract-v2 create-attempt: POST /tasks/{task_id}/attempts
  // (attempt_number auto-increments server-side)
  'attempt.create': () => post(
    apiPath(`/tasks/${params.taskId}/attempts`),
  ),

  'attempt.get': () => get(apiPath(`/attempts/${params.id}`)),

  'attempt.list': () => get(
    apiPath(`/tasks/${params.taskId}/attempts`),
    pageParams(params),
  ),

  // contract-v2 transition-attempt: POST /attempts/{id}/transition
  'attempt.transition': () => post(
    apiPath(`/attempts/${params.id}/transition`),
    {
      target_status:                    params.status ?? params.targetStatus,
      failure_reason:                   params.failureReason,
      blocked_on_approval_request_ids:  params.blockedOnApprovalRequestIds,
    },
  ),

  // =========================================================================
  //  EVENT BINDING  (定时任务 / create-by-agent — cws-core /event-bindings)
  // Creation keeps the caller as Lead; verified creator confirmation may assign
  // another eligible human Owner. Requester and target Owner are distinct.
  // =========================================================================

  // The target is a project (projectId) or, for an automation attached to no
  // project, its unattached scope (unattachedScope → unattached_scope); Core
  // refuses a query naming both.
  'automation.eligibility': () => {
    const scoped = params.unattachedScope !== undefined;
    if (scoped && (!['org', 'private'].includes(params.unattachedScope) || params.projectId !== undefined)) {
      throw Object.assign(new Error('eligibility unattachedScope must be org or private, without projectId'), { status: 400 });
    }
    if (!scoped && (typeof params.projectId !== 'string' || !params.projectId.trim())) {
      throw Object.assign(new Error('eligibility requires projectId (project UUID) or unattachedScope (org or private)'), { status: 400 });
    }
    if (typeof params.memberId !== 'string' || !params.memberId.trim()
      || !['create', 'update', 'replace', 'lead_change'].includes(params.operation)) {
      throw Object.assign(new Error('eligibility requires memberId and operation create, update, replace or lead_change'), { status: 400 });
    }
    return get(apiPath(`/agents/${encodeURIComponent(params.memberId)}/automation-creation-eligibility`), {
      operation: params.operation,
      ...(scoped ? { unattached_scope: params.unattachedScope } : { project_id: params.projectId }),
    });
  },
  'automation.authorization_preview': () => post(apiPath('/automation-authorizations/preview'), automationAuthorizationPreview(params)),
  'automation.authorization_propose': () => post(apiPath('/automation-authorizations/proposals'), automationAuthorizationProposal(params), { retryOn401: false }),
  'automation.authorization_status': () => {
    if (typeof params.proposal_message_id !== 'string' || !/^[1-9][0-9]*$/.test(params.proposal_message_id)
      || params.proposal_message_id.length > 128) {
      throw Object.assign(new Error('proposal_message_id must be a canonical decimal message ID string'), { status: 400 });
    }
    return get(apiPath(`/automation-authorizations/proposals/${params.proposal_message_id}`));
  },
  'event-binding.create': () => post(apiPath('/event-bindings'), automationMutation(params, 'timer'), { retryOn401: false }),
  'event-binding.update': () => put(apiPath(`/event-bindings/${encodeURIComponent(params.id)}`), automationMutation(params, 'timer', 'update'), { retryOn401: false }),

  'webhook.create': () => post(apiPath('/webhooks'), automationMutation(params, 'webhook'), { retryOn401: false }),
  'webhook.update': () => put(apiPath(`/webhooks/${encodeURIComponent(params.id)}`), automationMutation(params, 'webhook', 'update'), { retryOn401: false }),
  'webhook.get': () => get(apiPath(`/webhooks/${encodeURIComponent(params.id)}`)),

  'event-binding.list': () => get(apiPath('/event-bindings')),

  'event-binding.get': () => get(apiPath(`/event-bindings/${params.id}`)),
  'event-binding.runs': () => {
    requireTextParams('event-binding.runs', ['org', 'id']);
    for (const [name, min, max] of [['limit', 1, 100], ['offset', 0, 2147483647]]) {
      if (params[name] !== undefined && (!Number.isInteger(params[name]) || params[name] < min || params[name] > max)) {
        throw new Error(`event-binding.runs ${name} must be an integer from ${min} to ${max}`);
      }
    }
    return get(apiPath(`/event-bindings/${encodeURIComponent(params.id)}/runs`), {
      limit: params.limit, offset: params.offset,
    });
  },

  // Operating an existing automation from chat (references/automation-operate.md).
  // pause stops future triggers; resume validates dependencies and returns the
  // binding with next_trigger_at; run creates one manual run (a new Issue that
  // costs credits) without changing pause state or the schedule. A retry with
  // the same idempotency_key at the current version returns that run instead
  // of a second one; the replay is version-checked too, so after an edit, pause
  // or resume the old version gets VERSION_CONFLICT, not the existing run.
  'event-binding.pause': () => automationOperation('event-binding.pause', 'pause'),
  'event-binding.resume': () => automationOperation('event-binding.resume', 'resume'),
  'event-binding.run': () => automationOperation('event-binding.run', 'run', { run: true }),

  // 删除 binding 只停止后续触发,不影响已触发生成的 Issue。
  'event-binding.delete': () => del(apiPath(`/event-bindings/${params.id}`)),

};

function printUsage() {
  console.log(`TM CLI — Task Management against cws-core@contract-v2

Usage: node src/cli/tm.js <command> '<json-params>'

PROJECT  (all ✅ on contract-v2)
  project.list           {status?, query?, page?, pageSize?, orderBy?}
  project.create         {name, leadMemberId, description?, slug?, isDefault?,
                          knowledgeBaseId?, memberIds?}
  project.get            {id}
  project.update         {id, name?, description?, leadMemberId?, knowledgeBaseId?}
  project.archive        {id}
  project.members        {id, page?, pageSize?, orderBy?}
  project.member_add     {id, memberId, role?}                               # role default: member
  project.member_remove  {id, memberId}

ISSUE  (all ✅ on contract-v2 — write paths use /issues/{id}, NOT /projects/{pid}/issues/{id})
  issue.list             {status?, statuses?, priority?, includeArchived?, includeAutomation?, query?, page?, pageSize?, orderBy?}
  issue.list_in_project  {projectId, status?, statuses?, priority?, includeArchived?, includeAutomation?, query?, page?, pageSize?, orderBy?}
                         # automation-run Issues are excluded unless includeAutomation=true; includeAutomation: true|false only
  issue.get              {id}
  issue.create           {projectId, title, leadAgentId,
                          ownerMemberId, priority?,
                          description?, originConversationId?, originMessageId?,
                          backlog?}                                          # backlog default true; set false to start in_progress
  issue.update           {id, title?, description?, priority?}
  issue.activate         {id, source?}                                        # source: lead_chat|ui|event_binding|system
  issue.submit_plan      {id, planText, blueprintId, source?, cardMessageId?}
  issue.accept_plan      {id, source?}                                        # source: im|explicit|text_card_proxy; default text_card_proxy
  issue.deliver          {id, summary?, outcome?, artifacts?, idempotencyKey?}  # structured result requires summary/outcome/key; outcome: success|partial|failed
  issue.create_revision {id, description, originMessageId, idempotencyKey}      # linked automation revision; server verifies human message
  issue.resume           {id, reason?, source?}                               # human feedback → in_progress
  issue.accept_delivered {id, source?}                                        # source: im|explicit|text_card_proxy; default text_card_proxy
  issue.reassign_owner   {id, newOwnerMemberId (or 'ownerMemberId')}          # change issue owner
  issue.move_project     {id, newProjectId (or 'targetProjectId')}
  issue.terminate        {id, reason?, source?}                           # 提前终止 → terminated; 级联取消 Task + 发善后事件

TASK  (all ✅ on contract-v2; create uses doubly-nested path)
  task.list              {projectId?, issueId?, status?, includeArchived?, page?, pageSize?, orderBy?}
  task.get               {id}
  task.create            {projectId, issueId, title, description?,
                          assigneeId?, blueprintStepId?, dependsOn?}            # dependsOn entries are upstream task.id
  task.claim             {id}                                                    # 只分配 pending→assigned; no body
  task.start             {id}                                                    # assigned→running + 开 attempt; no body
  task.transition        {id, targetStatus}                                      # alias: task.status
  task.reassign          {id, newAssigneeId (or 'assigneeId')}

COMMENT  (issue/task discussion + agent-to-agent handoff channel)
  comment.create         {workType ('issue'|'task'), workId, bodyMarkdown}       # author from auth; markdown body
  comment.get            {id}                                                    # comments are addressable
  comment.list           {workType, workId, cursor?, limit?, orderBy?}

BLUEPRINT  (all ✅ on contract-v2)
  blueprint.create                  {issueId, steps[], estimatedBudget?, notes?}
  blueprint.get                     {id, includeSteps?}
  blueprint.list                    {issueId, page?, pageSize?, orderBy?}
  blueprint.set_steps               {blueprintId (or 'id'), steps[]}             # replaces ALL steps

ATTEMPT  (all ✅ on contract-v2)
  attempt.create         {taskId}                                                # attempt_number auto-increments
  attempt.get            {id}
  attempt.list           {taskId, page?, pageSize?, orderBy?}
  attempt.transition     {id, targetStatus (or 'status'), failureReason?,
                          blockedOnApprovalRequestIds?}

EVENT BINDING  (定时任务 / create-by-agent)
  automation.eligibility {org, memberId, operation:"create"|"update"|"replace"|"lead_change", projectId | unattachedScope:"org"|"private"} # project UUID, or the scope of an automation attached to no project (never both); read compatible Agent capability
  automation.authorization_propose {org, request_id, requester_member_id?, source_kind, operation, configuration, target_binding_id?, expected_version?, replaces_proposal_message_id?} # server sends one confirmation card to the verified requester
  automation.authorization_status {org, proposal_message_id} # authoritative card decision and interaction ID
  automation.authorization_preview {org, source_kind, operation, configuration, target_binding_id?, expected_version?} # retired; new server returns 410; never use as fallback
  event-binding.create   {org, source_kind:"timer", configuration, authorization_proposal_message_id, authorization_card_interaction_id}
  event-binding.update   {org, id, expected_version, source_kind:"timer", configuration, authorization_proposal_message_id, authorization_card_interaction_id}
                         Legacy: {cronExpr, leadMemberId, ownerMemberId, projectId,
                          title, description?}                                   # agent: leadMemberId=自己, ownerMemberId=对话人类
  event-binding.list     {}                                                     # 本 org 的定时任务
  webhook.create         {org, source_kind:"webhook", configuration, authorization_proposal_message_id, authorization_card_interaction_id}
  webhook.update         {org, id, expected_version, source_kind:"webhook", configuration, authorization_proposal_message_id, authorization_card_interaction_id}
  # Registered legacy proposals use authorization_confirmation_message_id instead of card proof; never send both.
  webhook.get            {org, id}
  event-binding.get      {id}
  event-binding.runs     {org, id, limit?, offset?}                              # read trigger_kind and outcomes; limit 1..100, offset >=0
  event-binding.pause    {org, id, expected_version}                             # stop future triggers; Lead Agent only (references/automation-operate.md)
  event-binding.resume   {org, id, expected_version}                             # resume scheduling; the reply carries next_trigger_at
  event-binding.run      {org, id, expected_version, idempotency_key, confirm_paused?} # run once now: new Issue, costs credits; confirm first;
                         # one key per confirmed run (e.g. "chat-run:<card message id>"); confirm_paused only for a paused one
                         # a same-key retry finds an earlier run only with the current version (replays are version-checked)
                         # errors: bad params add {code:"INVALID_PARAMS", sent:false} (nothing sent); platform refusals add
                         # {code, reason, refused:true}; neither = transient (5xx, timeout, network, 401/408/429), outcome unknown
  event-binding.delete   {id}                                                   # 停止后续触发, 不影响已生成的 Issue

Environment:
  COCO_API_URL     cws-core base URL (default: http://127.0.0.1:8080)
  COCO_API_PREFIX  Path prefix override (default: /api/v1)
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
    if (err.report) Object.assign(payload, err.report);
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
