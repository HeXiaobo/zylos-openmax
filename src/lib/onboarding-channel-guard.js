/**
 * Guard for the onboarding IM card (`cardKind: "onboarding.channel"`): the card
 * must offer EVERY channel `core.onboarding_profile_options` returns.
 *
 * 🔴 Why this exists. Each `im_channels` entry carries `visible: true|false`
 * (the first 5 true). That flag is only the client's DISPLAY hint for the
 * 「默认露 5 个 + 其他 N 个渠道」 collapse — the card renderer already collapses
 * any list to 5 + an expander on its own. An Agent read `visible:false` as
 * "don't show" and sent the card with 5 channels + 「都不用」, so the owner
 * could never pick the other 7. The skill text says so now; this makes it
 * deterministic: the send is refused, naming the missing channels, before
 * anything is posted.
 *
 * The check is ORDERED. The card must carry the list exactly as the server
 * returns it for the Agent's own order (`im_order` — cn for `Asia/Shanghai` /
 * `Asia/Urumqi`, intl for anything else incl. unset/UTC; see
 * references/onboarding-lead.md §3), so the guard re-fetches with that same
 * `im_order` (derived from the same configured TZ the Agent is told to use)
 * and compares the non-decline options item by item, position by position.
 * Labels are matched against any of `label` / `label_zh` / `label_en`, so the
 * card's language does not matter.
 *
 * cws-comm caps `onboarding.channel` at 16 options. When `im_channels` + the
 * decline option would exceed that, the documented rule is: the first 15
 * channels in the given order, then 「都不用」. The expected list is therefore
 * `im_channels.slice(0, 15)` — any other 15, or the right 15 in another
 * order, is refused.
 *
 * A failed fetch never blocks the send: the guard warns and lets the card go.
 */

import { agentTimeZone } from './local-time.js';

export const ONBOARDING_CHANNEL_KIND = 'onboarding.channel';
export const ONBOARDING_CHANNEL_MAX_OPTIONS = 16;
const MAX_CHANNEL_OPTIONS = ONBOARDING_CHANNEL_MAX_OPTIONS - 1; // one slot for 「都不用」

export class OnboardingChannelGuardError extends Error {
  constructor(message, missing = []) {
    super(message);
    this.name = 'OnboardingChannelGuardError';
    this.field = 'options';
    this.missing = missing;
  }
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

function channelNames(ch) {
  return [ch?.label, ch?.label_zh, ch?.label_en, ch?.labelZh, ch?.labelEn]
    .map(norm)
    .filter(Boolean);
}

function displayName(ch) {
  return ch?.label || ch?.label_zh || ch?.label_en || ch?.type || '?';
}

const CN_ORDER_ZONES = new Set(['Asia/Shanghai', 'Asia/Urumqi']);

/** The `im_order` the Agent is told to request for its own timezone. */
export function imOrderForTimeZone(tz) {
  return CN_ORDER_ZONES.has(String(tz ?? '').trim()) ? 'cn' : 'intl';
}

/** Pull `im_channels` out of a profile-options response (enveloped or not). */
export function extractImChannels(res) {
  const list = res?.im_channels ?? res?.data?.im_channels;
  return Array.isArray(list) ? list : null;
}

/**
 * Throw unless an `onboarding.channel` request's non-decline options are
 * exactly `im_channels` (first 15 when over the cap), in the given order.
 *
 * @param {object} request  the built interaction-request body (buildChoiceRequest
 *   output, `{interaction_type, choice:{kind, options, …}}`), or a bare choice
 * @param {object} deps
 * @param {(imOrder:string) => Promise<any>} deps.fetchProfileOptions
 *   GET /onboarding/profile-options?im_order=<imOrder>
 * @param {string} [deps.imOrder]  override; default from the agent's TZ
 * @param {(msg:string) => void} [deps.warn]
 * @param {string} [verb]  name used in the error ("comm.ask_card" / "[CARD]")
 * @returns {Promise<{checked:boolean, reason?:string, imOrder?:string}>}
 */
export async function assertAllImChannels(request, deps = {}, verb = 'comm.ask_card') {
  const choice = request?.choice ?? request;
  if (choice?.kind !== ONBOARDING_CHANNEL_KIND) return { checked: false, reason: 'not an onboarding.channel card' };
  const warn = deps.warn || ((m) => console.warn(m));
  const imOrder = deps.imOrder || imOrderForTimeZone(agentTimeZone() || 'UTC');

  let channels;
  try {
    channels = extractImChannels(await deps.fetchProfileOptions(imOrder));
  } catch (err) {
    warn(`[${verb}] onboarding.channel guard skipped: could not fetch im_channels (${err?.message || err}); sending the card unchecked`);
    return { checked: false, reason: 'fetch failed' };
  }
  if (!channels || channels.length === 0) {
    warn(`[${verb}] onboarding.channel guard skipped: profile-options returned no im_channels; sending the card unchecked`);
    return { checked: false, reason: 'no im_channels' };
  }

  const expected = channels.slice(0, MAX_CHANNEL_OPTIONS);
  const offered = (choice.options || []).filter((o) => o && o.decline !== true);
  const matches = (opt, ch) => channelNames(ch).includes(norm(opt?.label));
  const isOffered = (ch) => offered.some((o) => matches(o, ch));

  const present = expected.filter(isOffered);
  const missing = expected.filter((ch) => !isOffered(ch));
  const extra = offered.filter((o) => !expected.some((ch) => matches(o, ch)));
  const orderNote = ` (im_order=${imOrder})`;
  const capNote = channels.length > MAX_CHANNEL_OPTIONS
    ? ` (im_channels has ${channels.length}; over the ${ONBOARDING_CHANNEL_MAX_OPTIONS}-option cap, send the first ${MAX_CHANNEL_OPTIONS} in the given order, then the decline option)`
    : '';
  const rule = 'Send EVERY im_channels entry from core.onboarding_profile_options (visible:true AND visible:false), in the given order, '
    + 'then 「都不用，就在这儿聊」 with decline:true last. `visible` is only the client\'s display hint for the '
    + '「5 + 其他 N 个渠道」 collapse — the card collapses the list itself; it never means "leave this channel out". Nothing was sent.';

  if (missing.length) {
    const missingNames = missing.map(displayName);
    const extraNote = extra.length
      ? `; not among the expected ${expected.length}: ${extra.map((o) => o.label).join(', ')}`
      : '';
    throw new OnboardingChannelGuardError(
      `${verb}: onboarding.channel card refused — it offers ${present.length} of the ${channels.length} im_channels; missing: ${missingNames.join(', ')}${extraNote}${capNote}${orderNote}. ${rule}`,
      missingNames,
    );
  }
  if (extra.length || offered.length !== expected.length) {
    const why = extra.length
      ? `offers channels that are not among the expected ${expected.length}: ${extra.map((o) => o.label).join(', ')}`
      : `offers ${offered.length} channel options for ${expected.length} expected channels (a channel is repeated)`;
    throw new OnboardingChannelGuardError(
      `${verb}: onboarding.channel card refused — wrong subset: it ${why}${capNote}${orderNote}. ${rule}`,
    );
  }
  const firstWrong = expected.findIndex((ch, i) => !matches(offered[i], ch));
  if (firstWrong !== -1) {
    throw new OnboardingChannelGuardError(
      `${verb}: onboarding.channel card refused — wrong order: option ${firstWrong + 1} is ${offered[firstWrong].label}, expected ${displayName(expected[firstWrong])}; `
        + `expected order${orderNote}: ${expected.map(displayName).join(', ')}${capNote}. Do not reorder. ${rule}`,
    );
  }
  return { checked: true, imOrder };
}
