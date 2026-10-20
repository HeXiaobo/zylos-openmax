/**
 * comm.ask (Q27: one entry, interactionType picks the card) and the form side
 * of comm.answered, run as the CLI runs. HOME is a temp dir holding a one-org
 * config, so neither the org lookup nor the pending-question file touches the
 * real install.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-ask-'));
  const dir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ orgs: { acme: { org_id: 'org-1', enabled: true } } }));
  return home;
}

const pendingFile = (home) => path.join(home, 'zylos/components/openmax/runtime/pending-questions.json');

/**
 * Run the CLI against a stub that answers with `response` — an object for
 * every route, or a function of the request; return its output and the requests.
 */
async function run(home, command, params, response = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      const body = typeof response === 'function' ? response(req) : response;
      res.end(JSON.stringify(req.url.startsWith('/api/v1/onboarding/') ? { data: {} } : body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await new Promise((resolve) => {
      execFile(process.execPath, [cliPath, command, JSON.stringify(params)], {
        env: {
          ...process.env,
          HOME: home,
          COCO_API_URL: `http://127.0.0.1:${port}`,
          COCO_API_PREFIX: '/api/v1',
          COCO_AUTH_TOKEN: 'cli-contract-token',
          COCO_USER_TOKEN: '',
          COCO_RPC_LOG: '0',
        },
      }, (error, stdout, stderr) => {
        // The result is the JSON block at the end of stdout; a log line may precede it.
        const start = stdout.search(/^[[{]/m);
        resolve({ code: error ? error.code : 0, out: start >= 0 ? JSON.parse(stdout.slice(start)) : null, err: stderr, requests });
      });
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const FORM = {
  conversationId: 'grp-1',
  kind: 'sdlc.requirement_intake',
  title: '需求打磨（1/2）',
  summary: '「客户看板」· 答完点一次提交',
  fields: [
    { key: 'audience', label: '谁来用？', options: [{ key: 'internal', label: '内部员工' }, { label: '外部客户' }] },
    { key: 'cc', label: '抄送谁？', required: false, options: ['产品', '设计'] },
  ],
};
const FORM_RES = { data: { message_id: 'f1', action_ids: [], form_option_ids: { audience: ['opt_1', 'opt_2'], cc: ['opt_3', 'opt_4'] } } };

test('comm.ask with interactionType "form" posts the form body and records the question', async () => {
  const home = tmpHome();
  const r = await run(home, 'comm.ask', { ...FORM, interactionType: 'form', answerers: ['m-kevin'] }, FORM_RES);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].url, '/api/v1/conversations/grp-1/interaction-requests');
  assert.equal(r.requests[0].body.interaction_type, 'form');
  assert.deepEqual(r.requests[0].body.form.answerers, ['m-kevin']);
  assert.equal(r.out.recorded, true);
  const [rec] = JSON.parse(fs.readFileSync(pendingFile(home), 'utf8'));
  assert.equal(rec.interactionType, 'form');
  assert.deepEqual(rec.askedOf, ['m-kevin']);
});

test('comm.ask with interactionType "choice" sends exactly what comm.ask_card sends', async () => {
  const choice = { conversationId: 'dm-1', kind: 'upgrade', askedOf: 'm-owner', title: '要升级吗', text: 'x', options: ['升级', '先不升'], clientMsgId: 'cmsg_same' };
  const res = { data: { message_id: 'c1', action_ids: ['opt_1', 'opt_2'] } };
  const a = await run(tmpHome(), 'comm.ask', { ...choice, interactionType: 'choice' }, res);
  const b = await run(tmpHome(), 'comm.ask_card', choice, res);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.deepEqual(a.requests.at(-1).body, b.requests.at(-1).body);
  assert.deepEqual(a.out, b.out);
});

test('comm.ask without kind, or without askedOf and answerers, is refused before sending', async () => {
  const noKind = await run(tmpHome(), 'comm.ask', { ...FORM, kind: undefined, askedOf: 'm-1' });
  const noOne = await run(tmpHome(), 'comm.ask', FORM);
  for (const r of [noKind, noOne]) {
    assert.notEqual(r.code, 0);
    assert.match(r.err, /kind and askedOf/);
    assert.equal(r.requests.length, 0);
  }
});

// ------------------------------------------------------------ comm.answered

function seed(home, records) {
  fs.mkdirSync(path.dirname(pendingFile(home)), { recursive: true });
  fs.writeFileSync(pendingFile(home), JSON.stringify(records));
}

const formRec = (over = {}) => ({
  kind: 'sdlc.requirement_intake', interactionType: 'form', cardMessageId: 'f1', conversationId: 'grp-1',
  askedOf: ['m-kevin', 'm-jessie'], askedAt: new Date().toISOString(),
  fields: { audience: ['opt_1', 'opt_2'], cc: ['opt_3', 'opt_4'] },
  questions: {
    audience: { label: '谁来用？', required: true, optionKeys: ['internal', ''], optionLabels: ['内部员工', '外部客户'] },
    cc: { label: '抄送谁？', required: false, optionKeys: ['', ''], optionLabels: ['产品', '设计'] },
  },
  ...over,
});

test('comm.answered on a form: per-question answers, any listed answerer is authorized', async () => {
  const home = tmpHome();
  seed(home, [formRec()]);
  const r = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: 'opt_1', actorMemberId: 'm-jessie' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.actionable, true);
  assert.equal(r.out.answered, '1/2');
  assert.deepEqual(r.out.answers.audience, { status: 'answered', optionIndexes: [0], optionKeys: ['internal'], labels: ['内部员工'], otherSelected: false, otherText: null });
  assert.equal(r.out.answers.cc.status, 'unanswered');
  assert.equal('group' in r.out, false);
});

test('comm.answered on a form: someone not asked is not actionable', async () => {
  const home = tmpHome();
  seed(home, [formRec()]);
  const r = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: ['opt_1'], actorMemberId: 'm-ann' });
  assert.equal(r.out.authorized, false);
  assert.equal(r.out.actionable, false);
});

test('comm.answered still reads a choice record written before forms (askedOf a string)', async () => {
  const home = tmpHome();
  seed(home, [{ kind: 'upgrade', cardMessageId: 'c1', conversationId: 'dm-1', askedOf: 'm-owner', actionIds: ['opt_1', 'opt_2'], askedAt: new Date().toISOString() }]);
  const r = await run(home, 'comm.answered', { cardMessageId: 'c1', actionId: 'opt_2', actorMemberId: 'm-owner' });
  assert.equal(r.out.actionable, true);
  assert.equal(r.out.optionIndex, 1);
});

test('split cards: wait for the group, remind at most once, then one complete answer', async () => {
  const home = tmpHome();
  const g = (i) => ({ group: { id: 'sdlc-1024', index: i, total: 2 } });
  seed(home, [formRec({ cardMessageId: 'f1', ...g(1) }), formRec({ cardMessageId: 'f2', ...g(2) })]);

  const first = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: 'opt_1', actorMemberId: 'm-kevin' });
  assert.equal(first.out.actionable, true);
  assert.equal(first.out.group.complete, false);
  assert.deepEqual(first.out.group.waiting, [2]);
  assert.equal(first.out.group.mayRemind, true);

  // The same receipt delivered again: still waiting, and the reminder is spent.
  const again = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: 'opt_1', actorMemberId: 'm-kevin' });
  assert.equal(again.out.group.complete, false);
  assert.equal(again.out.group.mayRemind, false);

  const second = await run(home, 'comm.answered', { cardMessageId: 'f2', selectedActionIds: 'opt_2,opt_4', actorMemberId: 'm-kevin' });
  assert.equal(second.out.group.complete, true);
  assert.equal(second.out.group.mayRemind, false);
  assert.deepEqual(second.out.group.answers.map((a) => a.index), [1, 2]);
  assert.deepEqual(second.out.group.answers[1].answers.cc.labels, ['设计']);

  const cleared = await run(home, 'comm.pending_clear', { conversationId: 'grp-1', groupId: 'sdlc-1024' });
  assert.equal(cleared.out.cleared, 2);
});

test('split cards: a card that expired unanswered is reported for a re-ask, with no reminder', async () => {
  const home = tmpHome();
  const old = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  seed(home, [
    formRec({ cardMessageId: 'f1', group: { id: 'g', index: 1, total: 2 } }),
    formRec({ cardMessageId: 'f2', askedAt: old, group: { id: 'g', index: 2, total: 2 } }),
  ]);
  const r = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: 'opt_1', actorMemberId: 'm-kevin' });
  assert.equal(r.out.group.complete, false);
  assert.deepEqual(r.out.group.needsReask, [2]);
  assert.equal(r.out.group.mayRemind, false);

  const pending = await run(home, 'comm.pending', {});
  assert.deepEqual(pending.out.find((p) => p.cardMessageId === 'f2').groupStatus.needsReask, [2]);
});

test('split cards: an accepted answer read again past the window stays accepted, so a re-asked card completes the group', async () => {
  const home = tmpHome();
  const old = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  seed(home, [
    formRec({ cardMessageId: 'f1', group: { id: 'g', index: 1, total: 2 } }),
    formRec({ cardMessageId: 'f2', askedAt: old, group: { id: 'g', index: 2, total: 2 } }),
  ]);
  const first = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: 'opt_1', actorMemberId: 'm-kevin' });
  assert.equal(first.out.actionable, true);

  // Card 1's window passes, and card 2 is re-asked under the same index.
  const records = JSON.parse(fs.readFileSync(pendingFile(home), 'utf8'));
  records.find((r) => r.cardMessageId === 'f1').askedAt = old;
  records.push(formRec({ cardMessageId: 'f2b', group: { id: 'g', index: 2, total: 2 } }));
  fs.writeFileSync(pendingFile(home), JSON.stringify(records));

  const again = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: 'opt_1', actorMemberId: 'm-kevin' });
  assert.equal(again.out.actionable, true, again.out.reason);
  assert.deepEqual(again.out.group.answered, [1]);
  assert.deepEqual(again.out.group.needsReask, []);

  const second = await run(home, 'comm.answered', { cardMessageId: 'f2b', selectedActionIds: 'opt_2', actorMemberId: 'm-kevin' });
  assert.equal(second.out.group.complete, true);
  assert.deepEqual(second.out.group.needsReask, []);
});

// ------------------------------------------------- review follow-ups (07)

test('comm.answered on a form: an answer past the window is not actionable', async () => {
  const home = tmpHome();
  seed(home, [formRec({ askedAt: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString() })]);
  const r = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: 'opt_1', actorMemberId: 'm-kevin' });
  assert.equal(r.out.expired, true);
  assert.equal(r.out.actionable, false);
  assert.match(r.out.reason, /expired/);
});

test('comm.answered on a form: no selected id answers nothing, and is not actionable', async () => {
  const home = tmpHome();
  seed(home, [formRec()]);
  const r = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: [], actorMemberId: 'm-kevin' });
  assert.equal(r.out.answered, '0/2');
  assert.equal(r.out.actionable, false);
  assert.match(r.out.reason, /no question/);
});

test('comm.answered on a form: a question answered only by "other" with text counts, and the card is actionable (v1.6)', async () => {
  const home = tmpHome();
  seed(home, [formRec()]);
  const r = await run(home, 'comm.answered', {
    cardMessageId: 'f1', selectedActionIds: '', otherSelected: 'audience', otherText: { audience: '合作方' }, actorMemberId: 'm-kevin',
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.actionable, true, r.out.reason);
  assert.equal(r.out.answered, '1/2');
  assert.deepEqual(r.out.answers.audience, {
    status: 'answered', optionIndexes: [], optionKeys: [], labels: [], otherSelected: true, otherText: '合作方',
  });
});

test('comm.answered on a form: "other" ticked with nothing typed is not an answer on its own', async () => {
  const home = tmpHome();
  seed(home, [formRec()]);
  const blank = await run(home, 'comm.answered', { cardMessageId: 'f1', otherSelected: 'audience,cc', actorMemberId: 'm-kevin' });
  assert.equal(blank.out.actionable, false);
  assert.equal(blank.out.answered, '0/2');
  assert.deepEqual([blank.out.answers.cc.otherSelected, blank.out.answers.cc.otherText], [true, null]);

  const withPick = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: 'opt_4', otherSelected: ['audience'], actorMemberId: 'm-kevin' });
  assert.equal(withPick.out.actionable, true, withPick.out.reason);
  assert.equal(withPick.out.answers.audience.status, 'unanswered');
  assert.equal(withPick.out.answers.audience.otherSelected, true);
});

test('comm.answered on a form: an "other" key not on the card is not actionable; a non-object otherText is refused', async () => {
  const home = tmpHome();
  seed(home, [formRec()]);
  const r = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: 'opt_1', otherSelected: 'scope', actorMemberId: 'm-kevin' });
  assert.equal(r.out.actionable, false);
  assert.match(r.out.reason, /question keys not on this card: scope/);

  const bad = await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: 'opt_1', otherText: '合作方', actorMemberId: 'm-kevin' });
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /otherText must be an object/);
});

test('comm.answered on a form: actionId carrying the comma-joined header value is split like selectedActionIds', async () => {
  const home = tmpHome();
  seed(home, [formRec()]);
  const r = await run(home, 'comm.answered', { cardMessageId: 'f1', actionId: 'opt_1,opt_4', actorMemberId: 'm-kevin' });
  assert.equal(r.out.actionable, true, r.out.reason);
  assert.equal(r.out.answered, '2/2');
});

test('E3 via the CLI: total=3 with two cards on file — no reminder, the missing card is a re-ask', async () => {
  const home = tmpHome();
  seed(home, [
    formRec({ cardMessageId: 'f1', group: { id: 'g3', index: 1, total: 3 } }),
    formRec({ cardMessageId: 'f2', group: { id: 'g3', index: 2, total: 3 } }),
  ]);
  await run(home, 'comm.answered', { cardMessageId: 'f1', selectedActionIds: 'opt_1', actorMemberId: 'm-kevin' });
  const r = await run(home, 'comm.answered', { cardMessageId: 'f2', selectedActionIds: 'opt_1', actorMemberId: 'm-kevin' });
  assert.equal(r.out.group.complete, false);
  assert.deepEqual(r.out.group.needsReask, [3]);
  assert.equal(r.out.group.mayRemind, false);
});

test('comm.pending_clear refuses one card of a group, and a groupId without its conversation', async () => {
  const home = tmpHome();
  seed(home, [formRec({ cardMessageId: 'f1', group: { id: 'g', index: 1, total: 2 } })]);
  const one = await run(home, 'comm.pending_clear', { cardMessageId: 'f1' });
  assert.notEqual(one.code, 0);
  assert.match(one.err, /groupId/);
  const noConv = await run(home, 'comm.pending_clear', { groupId: 'g' });
  assert.notEqual(noConv.code, 0);
  assert.match(noConv.err, /conversationId/);
  assert.equal(JSON.parse(fs.readFileSync(pendingFile(home), 'utf8')).length, 1, 'nothing cleared');
});

test('comm.ask: an empty askedOf falls back to answerers, as on the [CARD] path', async () => {
  const home = tmpHome();
  const r = await run(home, 'comm.ask', { ...FORM, askedOf: [], answerers: ['m-kevin'] }, FORM_RES);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(pendingFile(home), 'utf8'))[0].askedOf, ['m-kevin']);
});

test('comm.ask: a form in a group chat without answerers is sent, with a warning; with answerers, none', async () => {
  const conv = (type) => (req) => (req.method === 'GET' ? { data: { id: 'grp-1', type } } : FORM_RES);
  const bare = await run(tmpHome(), 'comm.ask', { ...FORM, askedOf: 'm-kevin' }, conv('group'));
  assert.equal(bare.code, 0, bare.err);
  assert.equal(bare.out.recorded, true);
  assert.match(bare.out.warning, /without answerers/);
  assert.equal('answerers' in bare.requests[0].body.form, false, 'warned, not defaulted');

  const restricted = await run(tmpHome(), 'comm.ask', { ...FORM, answerers: ['m-kevin'] }, conv('group'));
  assert.equal(restricted.out.warning, undefined);
  const dm = await run(tmpHome(), 'comm.ask', { ...FORM, askedOf: 'm-kevin' }, conv('dm'));
  assert.equal(dm.out.warning, undefined);
});
