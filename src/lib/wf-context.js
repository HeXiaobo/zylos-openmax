/**
 * Workflow context (wf_ref).
 *
 * A message sent from the right-hand panel of the OpenMax workflows page
 * carries message metadata that the server is expected to write
 *
 *   wf_ref: { workflow_id: string|null, run_id: string|null, page: string,
 *             step_n: number|null }
 *
 * telling the Agent which workflow, which run, and which page the user is on
 * (`run_id` is null when there is no run; on the create page `workflow_id` is
 * null too; `step_n` — which step is being edited — is set only on the `step`
 * page). The key is absent on every other message.
 *
 * The plugin does not verify where wf_ref came from: a sender can also put it
 * in the message metadata itself, so it has the same trust level as
 * preferred_connectors and is treated as a hint only.
 *
 * The bridge renders it as a structural self-closing <wf-context .../> element
 * in the inbound header (next to <message-context> / <connector-preference>),
 * not inside the user's text, so typed text cannot forge it. Values are passed
 * through as-is — no allow-list of pages or id formats (the design may still
 * change); only escaping is applied, which is safety, not validation. It is a
 * hint only: the workflows service's own records remain the source of truth.
 *
 * The same reference may arrive as a `workflow` item of `metadata.context`
 * (attrs workflow-id, run-id, page, step-n; OPENM-1351). workflowRefOf reads
 * that first and the old key as fallback, with the same value rules, so
 * <wf-context> is the same either way.
 */

import { agentContextItem } from './message-context.js';

// Attribute name ← metadata key. Only these keys are read; anything else in
// wf_ref is ignored.
const WF_REF_ATTRS = [
  ['workflow-id', 'workflow_id'],
  ['run-id', 'run_id'],
  ['page', 'page'],
  ['step-n', 'step_n'],
];

// Sanity bound on a malformed/abusive payload, far above any real id or page
// name. An over-long value is dropped rather than cut: a truncated id would
// point at the wrong thing.
export const MAX_WF_REF_VALUE_LENGTH = 200;

function attrText(raw) {
  // Scalars only: an object / array value is not something to render.
  if (raw === null || raw === undefined) return '';
  if (!['string', 'number', 'boolean', 'bigint'].includes(typeof raw)) return '';
  // Control characters and Unicode line/paragraph separators would break the
  // one-line element; collapse them (and runs of spaces) to one space.
  // eslint-disable-next-line no-control-regex
  const flat = String(raw).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat || [...flat].length > MAX_WF_REF_VALUE_LENGTH) return '';
  return flat;
}

/**
 * Read `wf_ref` from a fetched message (top-level `metadata`, or the nested
 * `message.metadata` envelope — same lookup as preferred_connectors). Returns
 * `{ 'workflow-id'?, 'run-id'?, page?, 'step-n'? }` (attribute name → value) with only
 * the usable values, or null when wf_ref is missing, not an object, or has no
 * usable value.
 */
export function wfRefFrom(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const meta = [msg.metadata, msg.message?.metadata]
    .find((m) => m && typeof m === 'object' && !Array.isArray(m) && 'wf_ref' in m);
  const raw = meta?.wf_ref;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const out = {};
  for (const [attr, key] of WF_REF_ATTRS) {
    const v = attrText(raw[key]);
    if (v) out[attr] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The workflow reference of a message, context first (OPENM-1351): the
 * `workflow` item of `metadata.context` (audience=agent), else `wf_ref`. Same
 * `{ 'workflow-id'?, 'run-id'?, page?, 'step-n'? }` (or null) as wfRefFrom.
 */
export function workflowRefOf(msg) {
  const item = agentContextItem(msg, 'workflow');
  if (item) {
    const out = {};
    for (const [attr] of WF_REF_ATTRS) {
      const v = attrText(item.attrs[attr]);
      if (v) out[attr] = v;
    }
    if (Object.keys(out).length) return out;
  }
  return wfRefFrom(msg);
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render the <wf-context .../> element. Returns '' when there is nothing to
 * render.
 */
export function formatWfContext(ref) {
  if (!ref || typeof ref !== 'object') return '';
  const attrs = WF_REF_ATTRS
    .filter(([attr]) => typeof ref[attr] === 'string' && ref[attr])
    .map(([attr]) => `${attr}="${escapeAttr(ref[attr])}"`);
  return attrs.length ? `<wf-context ${attrs.join(' ')}/>` : '';
}
