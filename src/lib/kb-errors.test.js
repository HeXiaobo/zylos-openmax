import assert from 'node:assert/strict';
import test from 'node:test';

import { KB_NOT_FOUND, kbErrorDetails, kbGoneHint } from './kb-errors.js';

const KB = '55555555-5555-5555-5555-555555555555';
const PARENT = '33333333-3333-3333-3333-333333333333';

// What client.js throws for a cws-core problem: message, status and the parsed body.
function httpError(status, error) {
  return Object.assign(new Error(error?.detail ?? `HTTP ${status}`), { status, body: error ? { error } : undefined });
}

test('KB_NOT_FOUND is reported as a deleted or missing knowledge base, with its id', () => {
  const err = httpError(404, { status: 404, code: KB_NOT_FOUND, detail: 'This knowledge base was deleted, does not exist, or is not visible to you.', meta: { kb_id: KB } });
  const out = kbErrorDetails('kb.page_create', { kbId: 'ignored-param', title: 't' }, err);
  assert.equal(out.code, KB_NOT_FOUND);
  assert.equal(out.kbId, KB, 'meta.kb_id is preferred over the request param');
  assert.equal(out.hint, kbGoneHint(KB));
  assert.match(out.hint, /was deleted, does not exist, or you can no longer access it/);
  assert.match(out.hint, /not "gateway not connected"/);
  assert.match(out.hint, /ask them to restore your access to it, pick or re-create a knowledge base, or update the project's \(or automation's\) knowledge base/);
  assert.match(out.hint, /If only your access is gone, the documents are still in that knowledge base: restoring your access is the fix/);
  assert.match(out.hint, /do not retry the same knowledge base and do not switch to another one on your own/);
  assert.match(out.hint, /In an automation run, say this in the run result: the result is the notification/);
});

test('KB_NOT_FOUND with a parent folder is the knowledge base, not the ambiguous parent hint (current cws-core checked the KB)', () => {
  for (const params of [{ kbId: KB, parentId: PARENT }, { kbId: KB, parentNodeId: PARENT }]) {
    const err = httpError(404, { status: 404, code: KB_NOT_FOUND, detail: 'gone', meta: { kb_id: KB } });
    const out = kbErrorDetails('kb.page_create', params, err);
    assert.deepEqual(out, { code: KB_NOT_FOUND, kbId: KB, hint: kbGoneHint(KB) });
    assert.doesNotMatch(out.hint, /parent folder/);
  }
});

test('KB_NOT_FOUND on any KB command gets the same knowledge base hint', () => {
  const err = httpError(404, { status: 404, code: KB_NOT_FOUND, detail: 'gone', meta: { kb_id: KB } });
  assert.deepEqual(kbErrorDetails('kb.get', { kbId: KB }, err), { code: KB_NOT_FOUND, kbId: KB, hint: kbGoneHint(KB) });
});

test('KB_NOT_FOUND without meta falls back to the kbId the command was given', () => {
  const err = httpError(404, { status: 404, code: KB_NOT_FOUND, detail: 'gone' });
  assert.equal(kbErrorDetails('kb.page_create', { kb_id: KB }, err).kbId, KB);
});

test('a plain 404 from kb.page_create without a parent folder means the knowledge base is gone (older cws-core)', () => {
  const err = httpError(404, { status: 404, code: 'KB_ERROR', detail: 'not found' });
  const out = kbErrorDetails('kb.page_create', { kbId: KB, title: 'Run report' }, err);
  assert.deepEqual(out, { code: 'KB_ERROR', kbId: KB, hint: kbGoneHint(KB) });
});

test('a plain 404 with a parent folder says which two things may be missing and how to tell', () => {
  for (const params of [{ kbId: KB, parentId: PARENT }, { kbId: KB, parentNodeId: PARENT }]) {
    const out = kbErrorDetails('kb.page_create', params, httpError(404, { status: 404, code: 'KB_ERROR', detail: 'not found' }));
    assert.equal(out.kbId, KB);
    assert.match(out.hint, new RegExp(`knowledge base ${KB} was deleted, does not exist or is no longer accessible to you, or the parent folder ${PARENT} no longer exists`));
    assert.match(out.hint, /Run kb\.get with this kbId: if it is also 404, the knowledge base is gone or no longer accessible to you/);
    assert.match(out.hint, /ask them to restore your access to it, pick or re-create a knowledge base/);
    assert.match(out.hint, /if it succeeds, the parent folder is gone/);
    assert.match(out.hint, /not "gateway not connected"/);
  }
});

test('a 404 without a cws-core error body is not reported as a deleted knowledge base (proxy / wrong URL)', () => {
  for (const params of [{ kbId: KB }, { kbId: KB, parentId: PARENT }]) {
    const out = kbErrorDetails('kb.page_create', params, httpError(404));
    assert.equal(out.kbId, KB);
    assert.equal(out.code, undefined);
    assert.notEqual(out.hint, kbGoneHint(KB));
    assert.match(out.hint, /no cws-core error body, so it may come from a proxy or a wrong server URL/);
    assert.match(out.hint, /Run kb\.get with this kbId: if cws-core answers 404 there/);
    assert.match(out.hint, /do not tell the owner the knowledge base was deleted/);
    assert.match(out.hint, /or if it succeeds \(the knowledge base is there\), the 404 did not come from cws-core/);
  }
  const restore = kbErrorDetails('kb.page_restore_trash', { pageId: 'p1' }, httpError(404));
  assert.match(restore.hint, /no cws-core error body/);
  assert.equal(restore.kbId, undefined);
  // The restore output carries no kbId, so the hint must not ask for "this kbId".
  assert.doesNotMatch(restore.hint, /this kbId/);
  assert.match(restore.hint, /Check kb\.pages_trashed \(and kb\.get on the knowledge base the page belonged to, if you know it\)/);
  assert.match(restore.hint, /do not tell the owner the knowledge base was deleted/);
});

test('restoring a page from the trash: 404 may mean its knowledge base was deleted', () => {
  const out = kbErrorDetails('kb.page_restore_trash', { pageId: 'p1' }, httpError(404, { status: 404, code: 'KB_ERROR', detail: 'not found' }));
  assert.equal(out.code, 'KB_ERROR');
  assert.equal(out.kbId, undefined);
  assert.match(out.hint, /the knowledge base it belongs to was deleted or is no longer accessible to you/);
  assert.match(out.hint, /not "gateway not connected"/);
});

test('other failures only gain the code; other commands keep their plain 404', () => {
  assert.deepEqual(kbErrorDetails('kb.page_create', { kbId: KB }, httpError(409, { status: 409, code: 'KB_REVISION_CONFLICT', detail: 'x' })), { code: 'KB_REVISION_CONFLICT' });
  assert.deepEqual(kbErrorDetails('kb.page_create', { kbId: KB }, httpError(403, { status: 403, detail: 'forbidden' })), {});
  assert.deepEqual(kbErrorDetails('kb.page_get', { pageId: 'p1' }, httpError(404, { status: 404, code: 'KB_ERROR', detail: 'not found' })), { code: 'KB_ERROR' });
  assert.deepEqual(kbErrorDetails('kb.page_create', { kbId: KB }, new Error('kbId is required')), {});
});
