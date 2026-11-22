import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertAllImChannels, imOrderForTimeZone, OnboardingChannelGuardError } from './onboarding-channel-guard.js';

// cws-core's CN-order list as int returned it (12 channels, first 5 visible).
const IM = [
  ['wecom', '企业微信', 'WeCom'], ['wechat', '个人微信', 'WeChat'], ['feishu', '飞书', 'Feishu'],
  ['dingtalk', '钉钉', 'DingTalk'], ['lark', 'Lark', 'Lark'], ['whatsapp', 'WhatsApp', 'WhatsApp'],
  ['telegram', 'Telegram', 'Telegram'], ['slack', 'Slack', 'Slack'], ['discord', 'Discord', 'Discord'],
  ['teams', 'Microsoft Teams', 'Microsoft Teams'], ['line', 'LINE', 'LINE'], ['email', '邮箱', 'Email'],
].map(([type, zh, en], i) => ({ type, label: zh, label_zh: zh, label_en: en, visible: i < 5 }));

const DECLINE = { label: '都不用，就在这儿聊', decline: true };
const card = (channels, extra = {}) => ({
  kind: 'onboarding.channel', title: 't', blocks: [], ...extra,
  options: [...channels.map((c) => ({ label: c.label })), DECLINE],
});
const fetchOk = (list = IM) => async () => ({ im_channels: list });
const silent = { warn() {} };

test('🔴 rejects an IM card that drops the visible:false channels', async () => {
  const fivePlusDecline = card(IM.filter((c) => c.visible));
  await assert.rejects(
    () => assertAllImChannels(fivePlusDecline, { fetchProfileOptions: fetchOk(), ...silent }),
    (err) => {
      assert.ok(err instanceof OnboardingChannelGuardError);
      assert.equal(err.missing.length, 7);
      assert.match(err.message, /offers 5 of the 12/);
      assert.match(err.message, /WhatsApp/);
      assert.match(err.message, /`visible` is only the client's display hint/);
      assert.match(err.message, /Nothing was sent/);
      return true;
    },
  );
});

test('rejects a card missing even one channel, and names it', async () => {
  await assert.rejects(
    () => assertAllImChannels(card(IM.slice(0, 11)), { fetchProfileOptions: fetchOk(), ...silent }),
    /missing: 邮箱/,
  );
});

test('passes with all 12 channels + decline', async () => {
  const r = await assertAllImChannels(card(IM), { fetchProfileOptions: fetchOk(), imOrder: 'cn', ...silent });
  assert.deepEqual(r, { checked: true, imOrder: 'cn' });
});

test('matches labels in either language (label / label_zh / label_en)', async () => {
  const en = { kind: 'onboarding.channel', options: IM.map((c) => ({ label: c.label_en })).concat(DECLINE) };
  const r = await assertAllImChannels(en, { fetchProfileOptions: fetchOk(), ...silent });
  assert.equal(r.checked, true);
});

test('🔴 12 channels in another order are refused as wrong order', async () => {
  const swapped = [IM[1], IM[0], ...IM.slice(2)];
  await assert.rejects(
    () => assertAllImChannels(card(swapped), { fetchProfileOptions: fetchOk(), ...silent }),
    (err) => {
      assert.ok(err instanceof OnboardingChannelGuardError);
      assert.match(err.message, /wrong order: option 1 is 个人微信, expected 企业微信/);
      assert.match(err.message, /Do not reorder/);
      return true;
    },
  );
});

test('a channel not in im_channels is refused as wrong subset', async () => {
  const req = card(IM);
  req.options.splice(3, 0, { label: 'ICQ' });
  await assert.rejects(
    () => assertAllImChannels(req, { fetchProfileOptions: fetchOk(), ...silent }),
    /wrong subset: it offers channels that are not among the expected 12: ICQ/,
  );
});

test('a repeated channel is refused as wrong subset', async () => {
  const req = card([...IM, IM[0]]);
  await assert.rejects(
    () => assertAllImChannels(req, { fetchProfileOptions: fetchOk(), ...silent }),
    /wrong subset: it offers 13 channel options for 12 expected channels/,
  );
});

test('🔴 re-fetches with the im_order the Agent\'s TZ selects (same order the card was built from)', async () => {
  assert.equal(imOrderForTimeZone('Asia/Shanghai'), 'cn');
  assert.equal(imOrderForTimeZone('Asia/Urumqi'), 'cn');
  assert.equal(imOrderForTimeZone('UTC'), 'intl');
  assert.equal(imOrderForTimeZone('America/New_York'), 'intl');
  assert.equal(imOrderForTimeZone(''), 'intl');
  const saved = process.env.TZ;
  const savedZylosDir = process.env.ZYLOS_DIR;
  // agentTimeZone() reads the agent's zylos .env before process.env.TZ; point
  // it at an empty dir so the host's own TZ= setting cannot decide the order.
  const emptyZylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-guard-tz-'));
  process.env.ZYLOS_DIR = emptyZylosDir;
  try {
    for (const [tz, want] of [['Asia/Shanghai', 'cn'], ['Europe/Berlin', 'intl']]) {
      process.env.TZ = tz;
      const seen = [];
      const r = await assertAllImChannels(card(IM), { fetchProfileOptions: async (o) => { seen.push(o); return { im_channels: IM }; }, ...silent });
      assert.deepEqual(seen, [want], tz);
      assert.equal(r.imOrder, want);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    if (savedZylosDir === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = savedZylosDir;
    fs.rmSync(emptyZylosDir, { recursive: true, force: true });
  }
});

test('the decline option does not count as a channel', async () => {
  // A decline whose label happens to equal a channel label must not satisfy it.
  const req = card(IM.slice(0, 11));
  req.options.push({ label: '邮箱', decline: true });
  await assert.rejects(() => assertAllImChannels(req, { fetchProfileOptions: fetchOk(), ...silent }), /missing: 邮箱/);
});

test('accepts the enveloped {data:{im_channels}} shape', async () => {
  const r = await assertAllImChannels(card(IM), { fetchProfileOptions: async () => ({ data: { im_channels: IM } }), ...silent });
  assert.equal(r.checked, true);
});

test('🔴 a failed fetch never blocks the send — it warns and passes', async () => {
  const warnings = [];
  const r = await assertAllImChannels(card(IM.slice(0, 5)), {
    fetchProfileOptions: async () => { throw Object.assign(new Error('boom'), { status: 500 }); },
    warn: (m) => warnings.push(m),
  });
  assert.equal(r.checked, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not fetch im_channels/);
});

test('an empty / missing im_channels list warns and passes', async () => {
  const warnings = [];
  const r = await assertAllImChannels(card(IM.slice(0, 5)), { fetchProfileOptions: async () => ({}), warn: (m) => warnings.push(m) });
  assert.equal(r.checked, false);
  assert.equal(warnings.length, 1);
});

test('other card kinds are not checked and nothing is fetched', async () => {
  let fetched = false;
  const r = await assertAllImChannels({ kind: 'onboarding.task', options: [{ label: 'x' }] }, {
    fetchProfileOptions: async () => { fetched = true; return { im_channels: IM }; },
  });
  assert.equal(r.checked, false);
  assert.equal(fetched, false);
});

const MANY = Array.from({ length: 18 }, (_, i) => ({ type: `c${i}`, label: `C${i}`, label_zh: `C${i}`, label_en: `C${i}`, visible: i < 5 }));

test('🔴 18 channels: the LAST 15 are refused (wrong subset, first three missing)', async () => {
  await assert.rejects(
    () => assertAllImChannels(card(MANY.slice(3)), { fetchProfileOptions: fetchOk(MANY), ...silent }),
    (err) => {
      assert.ok(err instanceof OnboardingChannelGuardError);
      assert.deepEqual(err.missing, ['C0', 'C1', 'C2']);
      assert.match(err.message, /not among the expected 15: C15, C16, C17/);
      assert.match(err.message, /first 15 in the given order/);
      return true;
    },
  );
});

test('🔴 18 channels: the first 15 reversed are refused (wrong order)', async () => {
  await assert.rejects(
    () => assertAllImChannels(card(MANY.slice(0, 15).reverse()), { fetchProfileOptions: fetchOk(MANY), ...silent }),
    /wrong order: option 1 is C14, expected C0/,
  );
});

test('18 channels: 15 that skip one of the first 15 are refused', async () => {
  const skipOne = [...MANY.slice(0, 7), ...MANY.slice(8, 16)];
  await assert.rejects(
    () => assertAllImChannels(card(skipOne), { fetchProfileOptions: fetchOk(MANY), ...silent }),
    /missing: C7; not among the expected 15: C15/,
  );
});

test('consistent with the 16-option cap: over 15 channels, the first 15 in order + decline passes', async () => {
  const many = MANY;
  const ok = await assertAllImChannels(card(many.slice(0, 15)), { fetchProfileOptions: fetchOk(many), ...silent });
  assert.equal(ok.checked, true);
  await assert.rejects(
    () => assertAllImChannels(card(many.slice(0, 14)), { fetchProfileOptions: fetchOk(many), ...silent }),
    /first 15 in the given order/,
  );
});
