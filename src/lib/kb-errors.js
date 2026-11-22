/**
 * Extra fields for a failed KB CLI command, so an Agent reads a page write
 * into a deleted or unknown knowledge base for what it is.
 *
 * Since cws-kb !290, creating a page in a knowledge base that does not exist
 * or was deleted (trashed) is refused with NotFound; a knowledge base the
 * caller can no longer see (e.g. access revoked) answers the same. cws-core
 * answers it on `kb.page_create` as 404 `KB_NOT_FOUND` with `meta.kb_id`; a
 * cws-core without that code answers a plain 404 (`KB_ERROR`). Either way it is
 * an answer about the knowledge base, never "gateway not connected": the Agent
 * must stop writing there and ask the owner to restore its access, pick or
 * re-create a knowledge base, or update the project's / automation's knowledge
 * base. A 404 without a cws-core error body is not that answer (it can be a
 * proxy or a wrong base URL), so it only gets a hint to check with kb.get.
 *
 * Returned fields (all optional, added next to `error` / `status`):
 *   code  — cws-core's stable error code, when the response carried one
 *   kbId  — the knowledge base the write was aimed at
 *   hint  — what the 404 means and what to do
 */

export const KB_NOT_FOUND = 'KB_NOT_FOUND';

const OWNER_OPTIONS = 'ask them to restore your access to it, pick or re-create a knowledge base, or update the project\'s (or automation\'s) knowledge base';
const RUN_RESULT = 'In an automation run, say this in the run result: the result is the notification, do not send a separate message.';

export function kbGoneHint(kbId) {
  const which = kbId ? `Knowledge base ${kbId}` : 'The knowledge base';
  return `${which} was deleted, does not exist, or you can no longer access it, so nothing was written. `
    + 'This is not "gateway not connected" or a temporary outage: do not retry the same knowledge base and do not switch to another one on your own. '
    + `Tell the owner the knowledge base was deleted, does not exist or is no longer accessible to you, and ${OWNER_OPTIONS}. `
    + 'If only your access is gone, the documents are still in that knowledge base: restoring your access is the fix, not a new knowledge base. '
    + RUN_RESULT;
}

function parentHint(kbId, parentId) {
  const which = kbId ? `knowledge base ${kbId}` : 'the knowledge base';
  return `Not found: either ${which} was deleted, does not exist or is no longer accessible to you, or the parent folder ${parentId} no longer exists. `
    + 'This is not "gateway not connected". Run kb.get with this kbId: if it is also 404, the knowledge base is gone or no longer accessible to you '
    + `(tell the owner and ${OWNER_OPTIONS}; do not retry it or switch to another one on your own); `
    + 'if it succeeds, the parent folder is gone: re-read the tree and use an existing folder.';
}

const RESTORE_HINT = 'Not found: the page is no longer in the trash, or the knowledge base it belongs to was deleted or is no longer accessible to you '
  + '(a page cannot be restored into a deleted knowledge base). This is not "gateway not connected". '
  + 'Check kb.pages_trashed; if the knowledge base was deleted or you lost access to it, tell the owner instead of retrying.';

const NO_ENVELOPE = 'Not found, but the response had no cws-core error body, so it may come from a proxy or a wrong server URL rather than from cws-core. ';
const NOT_CORE = 'if that also fails without a cws-core error body, or if it succeeds (the knowledge base is there), the 404 did not come from cws-core: '
  + 'report a connection or configuration problem instead, do not retry in a loop, and do not tell the owner the knowledge base was deleted.';

function noEnvelopeHint(kbId) {
  const which = kbId ? `knowledge base ${kbId}` : 'the knowledge base';
  return NO_ENVELOPE
    + `Run kb.get with this kbId: if cws-core answers 404 there, ${which} was deleted, does not exist or is no longer accessible to you (tell the owner and ${OWNER_OPTIONS}); `
    + NOT_CORE;
}

const RESTORE_NO_ENVELOPE_HINT = NO_ENVELOPE
  + 'Check kb.pages_trashed (and kb.get on the knowledge base the page belonged to, if you know it): if cws-core answers there, act on its answer; '
  + NOT_CORE;

function str(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function kbErrorDetails(command, params, err) {
  const envelope = err?.body?.error && typeof err.body.error === 'object' ? err.body.error : null;
  const code = str(envelope?.code);
  const out = {};
  if (code) out.code = code;
  const kbId = str(envelope?.meta?.kb_id) ?? str(params?.kbId) ?? str(params?.kb_id);

  if (code === KB_NOT_FOUND) {
    if (kbId) out.kbId = kbId;
    out.hint = kbGoneHint(kbId);
    return out;
  }
  if (err?.status !== 404) return out;

  if (!envelope) {
    // Not cws-core's answer: only point at the check, never "the KB is gone".
    if (command === 'kb.page_create') {
      if (kbId) out.kbId = kbId;
      out.hint = noEnvelopeHint(kbId);
    } else if (command === 'kb.page_restore_trash') {
      out.hint = RESTORE_NO_ENVELOPE_HINT;
    }
    return out;
  }

  if (command === 'kb.page_create') {
    if (kbId) out.kbId = kbId;
    const parentId = str(params?.parentId) ?? str(params?.parentNodeId);
    // Without a parent folder, cws-kb's NotFound can only be the knowledge
    // base. With one, an older cws-core cannot say which is missing.
    out.hint = parentId ? parentHint(kbId, parentId) : kbGoneHint(kbId);
    return out;
  }
  if (command === 'kb.page_restore_trash') {
    out.hint = RESTORE_HINT;
  }
  return out;
}
