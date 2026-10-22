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
 *
 * Dual-send compatibility: during the rollout cws-comm sends the batch event
 * AND the legacy per-field events (dm_policy_changed, dm_allowlist_changed,
 * group_scope_changed, group_allowlist_changed) for the same save, each legacy
 * copy tagged with the batch's `batch_id`. Old plugins ignore the tag and apply
 * the legacy events; this plugin skips a tagged legacy event because the batch
 * already covers it (applying both would write and report the save twice and
 * bring back the stale-report race). Untagged legacy events — from a cws-comm
 * without dual-send — are applied and reported exactly as before.
 */

export const POLICY_UPDATED_EVENT = 'agent.config.policy_updated';

export const LEGACY_POLICY_EVENTS = new Set([
  'agent.config.dm_policy_changed',
  'agent.config.dm_allowlist_changed',
  'agent.config.group_scope_changed',
  'agent.config.group_allowlist_changed',
]);

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

/**
 * The batch id a legacy per-field event is tagged with, or null when it is
 * untagged (absent, not a string, or blank) and must be applied as before.
 */
export function legacyBatchId(data) {
  const id = data?.batch_id;
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

/**
 * Handle one legacy per-field policy event (one of LEGACY_POLICY_EVENTS).
 * A copy tagged with `batch_id` is skipped: no write, no report. An untagged
 * event is applied and reported exactly as the bridge always did; an invalid
 * one is warned about and neither written nor reported.
 *
 * @returns {{ skipped: true, batchId: string } | { skipped: false, applied: boolean }}
 */
export function handleLegacyPolicyEvent({ slug, event, data, update, report, log = () => {}, warn = () => {} }) {
  const batchId = legacyBatchId(data);
  if (batchId) {
    log(`[${slug}] skip legacy ${event.replace('agent.config.', '')}: covered by batch ${batchId}`);
    return { skipped: true, batchId };
  }

  switch (event) {
    case 'agent.config.dm_policy_changed': {
      const { policy } = data;
      if (!VALID_DM_POLICIES.has(policy)) {
        warn(`[${slug}] dm_policy_changed: invalid policy "${policy}"`);
        return { skipped: false, applied: false };
      }
      update(cfg => {
        const org = cfg.orgs?.[slug];
        if (!org) return;
        org.access = org.access || {};
        org.access.dmPolicy = policy;
      });
      log(`[${slug}] config updated: dmPolicy → ${policy} (by ${data.changed_by || '?'})`);
      break;
    }

    case 'agent.config.dm_allowlist_changed': {
      const { action, member_ids } = data;
      if (!Array.isArray(member_ids) || !member_ids.length) {
        warn(`[${slug}] dm_allowlist_changed: missing or empty member_ids`);
        return { skipped: false, applied: false };
      }
      update(cfg => {
        const org = cfg.orgs?.[slug];
        if (!org) return;
        org.access = org.access || {};
        org.access.dmAllowFrom = org.access.dmAllowFrom || [];
        if (action === 'add') {
          const existing = new Set(org.access.dmAllowFrom);
          for (const id of member_ids) if (!existing.has(id)) org.access.dmAllowFrom.push(id);
        } else if (action === 'remove') {
          const toRemove = new Set(member_ids);
          org.access.dmAllowFrom = org.access.dmAllowFrom.filter(id => !toRemove.has(id));
        } else if (action === 'set') {
          org.access.dmAllowFrom = [...member_ids];
        } else {
          warn(`[${slug}] dm_allowlist_changed: unknown action "${action}"`);
          return;
        }
      });
      log(`[${slug}] config updated: dmAllowFrom ${action} ${member_ids.length} member(s) (by ${data.changed_by || '?'})`);
      break;
    }

    case 'agent.config.group_scope_changed': {
      const { scope } = data;
      if (!VALID_GROUP_SCOPES.has(scope)) {
        warn(`[${slug}] group_scope_changed: invalid scope "${scope}"`);
        return { skipped: false, applied: false };
      }
      update(cfg => {
        const org = cfg.orgs?.[slug];
        if (!org) return;
        org.access = org.access || {};
        org.access.groupPolicy = scope;
      });
      log(`[${slug}] config updated: groupPolicy → ${scope} (by ${data.changed_by || '?'})`);
      break;
    }

    case 'agent.config.group_allowlist_changed': {
      const { action, conversation_ids: convIds } = data;
      if (!Array.isArray(convIds)) {
        warn(`[${slug}] group_allowlist_changed: conversation_ids is not an array`);
        return { skipped: false, applied: false };
      }
      if (!['add', 'remove', 'set'].includes(action)) {
        warn(`[${slug}] group_allowlist_changed: unknown action "${action}"`);
        return { skipped: false, applied: false };
      }
      update(cfg => {
        const org = cfg.orgs?.[slug];
        if (!org) return;
        org.access = org.access || {};
        org.access.groups = org.access.groups || {};
        if (action === 'add') {
          for (const id of convIds) {
            if (!org.access.groups[id]) org.access.groups[id] = DEFAULT_GROUP();
          }
        } else if (action === 'remove') {
          for (const id of convIds) delete org.access.groups[id];
        } else if (action === 'set') {
          const old = org.access.groups;
          org.access.groups = {};
          for (const id of convIds) org.access.groups[id] = old[id] || DEFAULT_GROUP();
        }
      });
      log(`[${slug}] config updated: group_allowlist ${action} ${convIds.length} conversation(s) (by ${data.changed_by || '?'})`);
      break;
    }

    default:
      throw new Error(`not a legacy policy event: ${event}`);
  }

  report();
  return { skipped: false, applied: true };
}
