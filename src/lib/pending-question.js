/**
 * Durable record of a choice card this agent is waiting on an answer to.
 *
 * A card asks a question in a conversation and the answer arrives, minutes or
 * days later, as a separate `interaction_receipt` message. The receipt names
 * the card it answers — and nothing else: it cannot say what the card was FOR.
 * So the question's meaning has to be written down when it is asked, or the
 * answer arrives decodable but meaningless.
 *
 * It lives on disk rather than in memory because every way this waiting ends
 * destroys memory: the model's session turns over, the service restarts, and
 * for the upgrade question specifically, the very act being authorized
 * restarts the process. In-memory state would die at exactly the moment it is
 * needed. Same reasoning, and the same shape, as connect-result-queue.js.
 *
 * `RUNTIME_DIR` is in the component's data directory, not the skill directory
 * `zylos upgrade` overwrites, so the record survives an upgrade. That is
 * load-bearing for the upgrade question specifically: the upgrade being
 * authorized replaces the code and restarts the service, and only afterwards
 * is the answer read back. `auto-upgrade.js` parks its marker in the same
 * directory for the same reason.
 *
 * A record can still be missing when a receipt arrives: the card was never
 * asked from here, `clearPendingQuestion` already retired it, or
 * `recordPendingQuestion` dropped the oldest to stay under
 * `PENDING_QUESTIONS_MAX`. `readAll` also turns an unreadable file into an
 * empty list, so corruption is indistinguishable from absence here. Either way
 * `findPendingQuestion` returns null and the answer is not actionable — the
 * safe direction, since the alternative is acting on a question nobody can
 * read back.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';

export const PENDING_QUESTIONS_PATH = path.join(RUNTIME_DIR, 'pending-questions.json');

/**
 * How long an answer still counts — see `isExpired`. 30 days, to match the
 * card's own interaction window: the choice-card reference states a 30-day
 * window for a card, and cws-comm carries the same figure as its card
 * interaction window.
 *
 * It is deliberately not shorter. A local deadline tighter than the server's is
 * the failure this module otherwise warns about — between the two, the card is
 * still live and clickable, the person answers it, the receipt arrives, and we
 * refuse an answer that both the server and the UI consider valid, blaming them
 * for being late.
 */
export const PENDING_QUESTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Bound the file. Questions are rare; a runaway writer is the only way to hit this. */
export const PENDING_QUESTIONS_MAX = 50;

function readAll(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    // Missing or corrupt: an unanswerable question is better than a crash on
    // every inbound receipt.
    return [];
  }
}

function writeAll(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(records, null, 2));
}

/**
 * Record a question. `cardMessageId` is the id the receipt will name, and
 * `actionIds` are the server's option ids in the order they were sent — the
 * only way to turn an answered action id back into which option it was.
 *
 * `askedAt` is passed in rather than read from the clock so the caller owns
 * the timestamp and the function stays testable.
 */
export function recordPendingQuestion(record, { file = PENDING_QUESTIONS_PATH } = {}) {
  const { kind, cardMessageId, conversationId, actionIds, askedAt } = record;
  if (!kind || !cardMessageId || !conversationId || !askedAt) {
    throw new Error('pending question: kind, cardMessageId, conversationId and askedAt are required');
  }
  if (record.interactionType === 'form') {
    // A form is decoded per question: `fields` maps each question key to its
    // server option ids in card order, the form's counterpart of `actionIds`.
    const fields = record.fields;
    const ok = fields && typeof fields === 'object' && Object.keys(fields).length > 0
      && Object.values(fields).every((ids) => Array.isArray(ids) && ids.length > 0);
    if (!ok) {
      throw new Error('pending question: a form needs fields {key: optionIds[]} — without it an answer cannot be decoded');
    }
  } else if (!Array.isArray(actionIds) || actionIds.length === 0) {
    throw new Error('pending question: actionIds is required — without it an answer cannot be decoded');
  }
  const records = readAll(file)
    .filter((r) => String(r.cardMessageId) !== String(cardMessageId));
  records.push({ ...record, cardMessageId: String(cardMessageId) });
  writeAll(file, records.slice(-PENDING_QUESTIONS_MAX));
  return record;
}

/** The question a receipt answers, or null when this agent never asked it. */
export function findPendingQuestion(cardMessageId, { file = PENDING_QUESTIONS_PATH } = {}) {
  if (!cardMessageId) return null;
  const want = String(cardMessageId);
  return readAll(file).find((r) => String(r.cardMessageId) === want) || null;
}

/**
 * Whether the answer arrived too late to act on. The caller supplies `now`,
 * again so the clock is the caller's.
 *
 * 🔴 This bounds the answer, it does not vouch for the action. Well inside
 * the window an answer can still be stale — a card asking "upgrade to v2?"
 * answered weeks later names a version that may no longer be the one on offer,
 * and upgrading on it upgrades to something nobody was asked about. So whoever
 * acts re-reads the current target and version first; the recorded parameters
 * are what was asked, never the authorization to run them now. This function
 * only says the answer arrived too late to count at all.
 */
export function isExpired(record, now, { ttlMs = PENDING_QUESTION_TTL_MS } = {}) {
  if (!record?.askedAt) return true;
  const asked = Date.parse(record.askedAt);
  if (Number.isNaN(asked)) return true;
  return now - asked > ttlMs;
}

/**
 * Whether this member's click counts. The interaction protocol has no
 * authorization of its own — anyone in the conversation can press the button —
 * so the question records who it was asked of, and the answer is checked
 * against that. Missing either side is a refusal, never a pass.
 *
 * `askedOf` is one member id (every record written before forms) or a list of
 * them (a form asked of several answerers, any one of whom settles it).
 */
export function isAnswerAuthorized(record, actorMemberId) {
  if (!actorMemberId) return false;
  const want = String(actorMemberId);
  return askedOfList(record).some((id) => id === want);
}

/** `askedOf` as a list of non-empty id strings, whichever shape was stored. */
export function askedOfList(record) {
  const raw = Array.isArray(record?.askedOf) ? record.askedOf : [record?.askedOf];
  return raw.filter((id) => id !== undefined && id !== null && id !== '').map(String);
}

/**
 * How close together two quick-reply cards to the same person count as "in a
 * row" (wsb#679): an agent with several questions for one person at once
 * should send one choice form, and sending single cards one after another is
 * the pattern this window catches.
 */
export const REPEAT_QUICK_REPLY_WINDOW_MS = 10 * 60 * 1000;

/**
 * The quick-reply card this agent already asked, in `conversationId`, of any
 * member in `askedOf`, at most `windowMs` before `nowIso` — or null.
 *
 * Call it before the new card is recorded, or the new card finds itself. A
 * form never counts, and neither does a card already answered and cleared
 * with `comm.pending_clear`: it is no longer on file. This only feeds a
 * warning, so anything it cannot read counts as "none".
 */
export function recentQuickReplyTo(conversationId, askedOf, nowIso, {
  file = PENDING_QUESTIONS_PATH,
  windowMs = REPEAT_QUICK_REPLY_WINDOW_MS,
} = {}) {
  const now = Date.parse(nowIso);
  const want = askedOfList({ askedOf });
  if (Number.isNaN(now) || !conversationId || want.length === 0) return null;
  const hits = readAll(file).filter((r) => {
    if (r.interactionType === 'form' || String(r.conversationId) !== String(conversationId)) return false;
    const asked = Date.parse(r.askedAt);
    if (Number.isNaN(asked) || asked > now || now - asked > windowMs) return false;
    return askedOfList(r).some((id) => want.includes(id));
  });
  return hits.at(-1) || null;
}

/** The `warning` a second quick-reply card in a row carries (wsb#679). */
export function repeatQuickReplyWarning(earlier) {
  return `a quick-reply card was already sent to the same person in this conversation within the last 10 minutes (card ${earlier.cardMessageId}). When you ask one person two or more questions at the same time, put them in ONE choice form (fields) instead of several single-question cards. This card was sent anyway.`;
}

/**
 * Read a form's selected option ids back into per-question answers.
 *
 * The receipt's flat `selected_action_ids` is enough: cws-comm numbers option
 * ids across the whole card (`opt_1…opt_N`, contract 04 §1.2), so each id
 * belongs to exactly one question. An id on no question is reported, not
 * dropped — an answer this side cannot place is not one to act on.
 *
 * "Other" has no option id, so it comes in beside the ids: `otherSelected`
 * lists the question keys where it was ticked (the header's `other-selected`)
 * and `otherText` maps a key to what the member typed (the receipt body). A
 * question counts as answered when it has an id or non-blank other text
 * (wsb#602 v1.6 §1); "other" ticked with nothing typed is reported as
 * `otherSelected: true, otherText: null` and does not count. A key on no
 * question is reported in `unknownKeys`, like an id on none.
 */
export function decodeFormAnswer(record, selectedIds, { otherSelected = [], otherText = {} } = {}) {
  const chosen = new Set((selectedIds || []).map(String));
  const ticked = new Set(otherSelected.map(String));
  const texts = otherText && typeof otherText === 'object' ? otherText : {};
  const placed = new Set();
  const answers = {};
  let answered = 0;
  for (const [key, optionIds] of Object.entries(record?.fields || {})) {
    const q = record.questions?.[key] || {};
    const indexes = [];
    optionIds.forEach((id, i) => {
      if (chosen.has(String(id))) { indexes.push(i); placed.add(String(id)); }
    });
    const text = typeof texts[key] === 'string' && texts[key].trim() ? texts[key].trim() : null;
    const isAnswered = indexes.length > 0 || text !== null;
    if (isAnswered) answered += 1;
    answers[key] = {
      status: isAnswered ? 'answered' : 'unanswered',
      optionIndexes: indexes,
      optionKeys: Array.isArray(q.optionKeys) ? indexes.map((i) => q.optionKeys[i] ?? '') : [],
      labels: Array.isArray(q.optionLabels) ? indexes.map((i) => q.optionLabels[i] ?? '') : [],
      otherSelected: ticked.has(key) || text !== null,
      otherText: text,
    };
  }
  const unknownIds = [...chosen].filter((id) => !placed.has(id));
  // Own keys only: `in` would also find `constructor`, `toString` … on the
  // prototype and take them for questions on the card.
  const unknownKeys = [...new Set([...ticked, ...Object.keys(texts)])]
    .filter((k) => !Object.prototype.hasOwnProperty.call(answers, k));
  return { answers, answered, total: Object.keys(answers).length, unknownIds, unknownKeys };
}

/**
 * Whether two decoded form answers say the same thing, question by question.
 *
 * Not a JSON comparison: an outcome stored by an older version has no
 * `otherSelected` (it could not read "other"), and comparing raw JSON would
 * turn an answer it accepted into an expired one on the first read after an
 * upgrade. A missing `otherSelected` is "not ticked"; labels and option keys
 * follow from the indexes, so only status, indexes and "other" are compared.
 */
export function sameFormAnswers(a, b) {
  const keysOf = (x) => Object.keys(x && typeof x === 'object' ? x : {}).sort();
  const ka = keysOf(a);
  const kb = keysOf(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  const norm = (q) => JSON.stringify([
    q?.status ?? '',
    Array.isArray(q?.optionIndexes) ? q.optionIndexes.map(Number) : [],
    q?.otherSelected === true,
    typeof q?.otherText === 'string' ? q.otherText : null,
  ]);
  return ka.every((k) => norm(a[k]) === norm(b[k]));
}

/**
 * Write what a form card's receipt said onto its record. Group completeness is
 * judged across receipts that arrive minutes or days apart, so each card's
 * outcome has to outlive the turn that read it. Writing the same outcome twice
 * (a redelivered receipt) changes nothing that is read.
 */
export function recordFormOutcome(cardMessageId, outcome, { file = PENDING_QUESTIONS_PATH } = {}) {
  const want = String(cardMessageId);
  const records = readAll(file);
  const r = records.find((x) => String(x.cardMessageId) === want);
  if (!r) return null;
  r.outcome = outcome;
  writeAll(file, records);
  return r;
}

/**
 * Where a split-card group stands (PRD §8.18, T-13 / T-14).
 *
 * A group is the cards recorded in one conversation under one `group.id`. Per
 * index, the newest record wins, so re-asking a missing card under the same id
 * and index replaces the dead one rather than leaving the group stuck on it.
 *
 * Per index: `answered` (an actionable outcome), `unusable` (settled, but not
 * by someone asked, or too late — the card cannot be answered again),
 * `expired` (no answer inside the window), `waiting`, or `notRecorded` (no
 * card on file for that index: never sent, cleared on its own, or pushed out
 * past PENDING_QUESTIONS_MAX). The group is `complete` only when every index
 * is answered. `needsReask` lists every index that cannot complete as asked —
 * `notRecorded` included, or a group missing one record would wait forever.
 * `answers` (once complete) is each index's answers in card order, from the
 * same newest-per-index choice.
 */
export function formGroupStatus(conversationId, groupId, now, { file = PENDING_QUESTIONS_PATH, records } = {}) {
  const all = records || readAll(file);
  const members = all.filter((r) => r.group && String(r.group.id) === String(groupId)
    && String(r.conversationId) === String(conversationId));
  if (!members.length) return null;
  const total = Math.max(...members.map((r) => Number(r.group.total) || 0));
  const byIndex = new Map();
  for (const r of members) byIndex.set(Number(r.group.index), r);

  const status = { id: String(groupId), total, answered: [], waiting: [], expired: [], unusable: [], notRecorded: [] };
  for (let i = 1; i <= total; i += 1) {
    const r = byIndex.get(i);
    if (!r) status.notRecorded.push(i);
    else if (r.outcome?.actionable) status.answered.push(i);
    else if (r.outcome) status.unusable.push(i);
    else if (isExpired(r, now)) status.expired.push(i);
    else status.waiting.push(i);
  }
  status.complete = total > 0 && status.answered.length === total;
  status.needsReask = [...status.unusable, ...status.expired, ...status.notRecorded].sort((a, b) => a - b);
  status.reminded = members.some((r) => r.groupRemindedAt);
  if (status.complete) {
    status.answers = status.answered.map((i) => {
      const r = byIndex.get(i);
      return { index: i, cardMessageId: r.cardMessageId, answers: r.outcome.answers };
    });
  }
  return status;
}

/**
 * Note that the one reminder a partly answered group is allowed has been
 * spent. Returns true only the first time, so the caller that gets true is the
 * one that may remind.
 */
export function claimGroupReminder(conversationId, groupId, nowIso, { file = PENDING_QUESTIONS_PATH } = {}) {
  const records = readAll(file);
  const members = records.filter((r) => r.group && String(r.group.id) === String(groupId)
    && String(r.conversationId) === String(conversationId));
  if (!members.length || members.some((r) => r.groupRemindedAt)) return false;
  for (const r of members) r.groupRemindedAt = nowIso;
  writeAll(file, records);
  return true;
}

/**
 * Drop every card of a group once the group has been acted on. The group id
 * is the agent's own and can repeat across conversations, so the
 * conversation is required: without it this would clear every same-named
 * group.
 */
export function clearPendingGroup(conversationId, groupId, { file = PENDING_QUESTIONS_PATH } = {}) {
  if (!conversationId || !groupId) {
    throw new Error('pending question: clearing a group needs both conversationId and groupId');
  }
  const records = readAll(file);
  const kept = records.filter((r) => !(r.group && String(r.group.id) === String(groupId)
    && String(r.conversationId) === String(conversationId)));
  if (kept.length !== records.length) writeAll(file, kept);
  return records.length - kept.length;
}

/** Drop a question once it has been acted on, or when it expired unanswered. */
export function clearPendingQuestion(cardMessageId, { file = PENDING_QUESTIONS_PATH } = {}) {
  const want = String(cardMessageId);
  const records = readAll(file);
  const kept = records.filter((r) => String(r.cardMessageId) !== want);
  if (kept.length !== records.length) writeAll(file, kept);
  return records.length - kept.length;
}

/** Every question still on file, newest last. Used by the CLI to show state. */
export function listPendingQuestions({ file = PENDING_QUESTIONS_PATH } = {}) {
  return readAll(file);
}
