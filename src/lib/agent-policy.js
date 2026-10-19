/**
 * Agent access policy: the batch config event and the reported-policy snapshot.
 *
 * `agent.config.policy_updated` (cws-comm, OPENM-874) carries every item one
 * web "Save" changed, as absolute targets:
 *
 *   { org_id, agent_member_id, batch_id,
 *     dm_policy?, dm_allowlist?: [...], group_scope?, group_allowlist?: [...],
 *     changed_by, occurred_at }
 *
 * An absent (or null) field means "unchanged"; a list is the full target and
 * may be empty. The whole event is validated before anything is written, then
 * all items land in one config write, and the caller reports one full
 * snapshot. An invalid item rejects the whole event (no partial apply).
 */

export const POLICY_UPDATED_EVENT = 'agent.config.policy_updated';

export const VALID_DM_POLICIES = new Set(['open', 'allowlist', 'owner']);
export const VALID_GROUP_SCOPES = new Set(['open', 'allowlist', 'disabled']);

const DEFAULT_GROUP = () => ({ mode: 'mention', allowFrom: ['*'] });

function present(value) {
  return value !== undefined && value !== null;
}

function validIdList(value) {
  return Array.isArray(value) && value.every(id => typeof id === 'string' && id.trim() !== '');
}

/**
 * Validate a policy_updated payload. Unknown fields are ignored.
 * @returns {{ ok: true, items: object, fields: string[] } | { ok: false, reason: string }}
 */
export function validatePolicyBatch(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'missing_data' };
  if (present(data.batch_id) && typeof data.batch_id !== 'string') {
    return { ok: false, reason: 'invalid_batch_id' };
  }

  const items = {};
  const fields = [];

  if (present(data.dm_policy)) {
    if (!VALID_DM_POLICIES.has(data.dm_policy)) return { ok: false, reason: `invalid dm_policy "${data.dm_policy}"` };
    items.dmPolicy = data.dm_policy;
    fields.push('dm_policy');
  }
  if (present(data.dm_allowlist)) {
    if (!validIdList(data.dm_allowlist)) return { ok: false, reason: 'invalid dm_allowlist (expected array of ids)' };
    items.dmAllowFrom = [...new Set(data.dm_allowlist)];
    fields.push('dm_allowlist');
  }
  if (present(data.group_scope)) {
    if (!VALID_GROUP_SCOPES.has(data.group_scope)) return { ok: false, reason: `invalid group_scope "${data.group_scope}"` };
    items.groupPolicy = data.group_scope;
    fields.push('group_scope');
  }
  if (present(data.group_allowlist)) {
    if (!validIdList(data.group_allowlist)) return { ok: false, reason: 'invalid group_allowlist (expected array of conversation ids)' };
    items.groupIds = [...new Set(data.group_allowlist)];
    fields.push('group_allowlist');
  }

  if (!fields.length) return { ok: false, reason: 'no policy items' };
  return { ok: true, items, fields };
}

/** Apply validated items to one org's access block (mutates `access`). */
export function applyPolicyItems(access, items) {
  if ('dmPolicy' in items) access.dmPolicy = items.dmPolicy;
  if ('dmAllowFrom' in items) access.dmAllowFrom = [...items.dmAllowFrom];
  if ('groupPolicy' in items) access.groupPolicy = items.groupPolicy;
  if ('groupIds' in items) {
    // Same as group_allowlist_changed/set: keep the mode/allowFrom of groups
    // that stay listed, new ones get the default.
    const old = access.groups || {};
    access.groups = {};
    for (const id of items.groupIds) access.groups[id] = old[id] || DEFAULT_GROUP();
  }
  return access;
}

/**
 * Handle one agent.config.policy_updated event: validate everything, write
 * config at most once, then report exactly once (the current snapshot, so an
 * invalid event still tells the server the real state).
 *
 * @param {object} p
 * @param {string} p.slug - org slug in config.json
 * @param {object} p.data - event data
 * @param {(mutate: (cfg: object) => void) => object} p.update - config writer
 * @param {() => void} p.report - sync live config + send the full snapshot
 * @returns {{ applied: boolean, reason?: string, fields?: string[] }}
 */
export function handlePolicyUpdated({ slug, data, update, report, log = () => {}, warn = () => {} }) {
  const batch = data?.batch_id || '?';
  const v = validatePolicyBatch(data);
  let result;
  if (!v.ok) {
    warn(`[${slug}] policy_updated batch=${batch} rejected: ${v.reason}; nothing applied`);
    result = { applied: false, reason: v.reason };
  } else {
    let found = false;
    update(cfg => {
      const org = cfg.orgs?.[slug];
      if (!org) return;
      found = true;
      org.access = org.access || {};
      applyPolicyItems(org.access, v.items);
    });
    if (found) {
      log(`[${slug}] config updated: policy batch=${batch} ${v.fields.map(f => describe(f, v.items)).join(', ')} (by ${data.changed_by || '?'})`);
      result = { applied: true, fields: v.fields };
    } else {
      warn(`[${slug}] policy_updated batch=${batch}: org not in config, nothing applied`);
      result = { applied: false, reason: 'org_not_found' };
    }
  }
  report();
  return result;
}

function describe(field, items) {
  switch (field) {
    case 'dm_policy': return `dmPolicy → ${items.dmPolicy}`;
    case 'dm_allowlist': return `dmAllowFrom → ${items.dmAllowFrom.length} member(s)`;
    case 'group_scope': return `groupPolicy → ${items.groupPolicy}`;
    case 'group_allowlist': return `groups → ${items.groupIds.length} conversation(s)`;
    default: return field;
  }
}

/** Full-snapshot body for PUT /agents/{id}/reported-policy. */
export function buildReportedPolicy(access = {}) {
  const groups = [];
  const groupAllowlist = [];
  for (const [convId, gcfg] of Object.entries(access.groups || {})) {
    groupAllowlist.push(convId);
    groups.push({
      conversation_id: convId,
      mode: gcfg.mode || 'mention',
      allow_from: gcfg.allowFrom || ['*'],
    });
  }
  return {
    dm_policy: access.dmPolicy || 'owner',
    dm_allowlist: access.dmAllowFrom || [],
    group_scope: access.groupPolicy || 'allowlist',
    group_allowlist: groupAllowlist,
    groups,
  };
}
