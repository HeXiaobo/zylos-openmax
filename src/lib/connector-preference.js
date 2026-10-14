/**
 * Connector preference (OPENM-915).
 *
 * The connector switch in the OpenMax input box means "prefer these", never
 * "only these": nothing is blocked per conversation. When the user picked a
 * strict subset, the web FE attaches message metadata
 *
 *   preferred_connectors: [{ connection_id: string, label: string }]
 *
 * where `label` is already formatted by the FE (e.g. 「应用名·连接名（组织）」).
 * The key is absent when every connector is selected, on old FE builds, and on
 * anything not sent from the input box — all of which render nothing.
 *
 * The bridge renders it as a structural <connector-preference> element in the
 * inbound header (next to <message-context>), not inside the user's text. It is
 * a hint for choosing between connections, not an authorization: conn.* never
 * reads it.
 */

export const MAX_PREFERRED_CONNECTORS = 20;
export const MAX_PREFERRED_LABEL_LENGTH = 60;

// Connection ids are interpolated into an attribute; accept only id-shaped
// strings so nothing can break out of it.
const CONNECTION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function oneLineLabel(raw) {
  if (typeof raw !== 'string') return '';
  // Control characters and Unicode line/paragraph separators would break the
  // two-line framing of the element; collapse them (and runs of spaces) to one.
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const chars = [...flat];
  if (chars.length <= MAX_PREFERRED_LABEL_LENGTH) return flat;
  return `${chars.slice(0, MAX_PREFERRED_LABEL_LENGTH - 1).join('')}…`;
}

/**
 * Read `preferred_connectors` from a fetched message (top-level `metadata`, or
 * the nested `message.metadata` envelope). Returns a normalized
 * `[{ connectionId, label }]`, or null when there is nothing usable. Malformed
 * entries are dropped individually; duplicates (by id) keep the first.
 */
export function preferredConnectorsFrom(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const meta = [msg.metadata, msg.message?.metadata]
    .find((m) => m && typeof m === 'object' && !Array.isArray(m) && 'preferred_connectors' in m);
  const raw = meta?.preferred_connectors;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= MAX_PREFERRED_CONNECTORS) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = item.connection_id;
    if (typeof id !== 'string' || !CONNECTION_ID_RE.test(id) || seen.has(id)) continue;
    const label = oneLineLabel(item.label);
    if (!label) continue;
    seen.add(id);
    out.push({ connectionId: id, label });
  }
  return out.length ? out : null;
}

function escapeText(s) {
  return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render the <connector-preference> element: exactly two content lines (the
 * wording agreed with PM). Returns '' when there is nothing to render.
 */
export function formatConnectorPreference(prefs) {
  if (!Array.isArray(prefs) || prefs.length === 0) return '';
  const ids = prefs.map((p) => p.connectionId).join(',');
  const list = prefs.map((p) => escapeText(p.label)).join('、');
  return [
    `<connector-preference connection-ids="${ids}">`,
    `用户在本对话把这些连接器设为优先使用：${list}。相关请求先用它们，不用再问用哪个。`,
    '其他已授权的连接器需要时也可以用，但要在回复里说一句「这次用了 X」。',
    '</connector-preference>',
  ].join('\n');
}
