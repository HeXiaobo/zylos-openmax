import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSystemSender, senderMemberFrom, systemEventPriority } from './system-message.js';

test('isSystemSender: 顶层 sender_type=SYSTEM 命中（实时 WS 帧）', () => {
  assert.equal(isSystemSender({ sender_type: 'SYSTEM' }), true);
  assert.equal(isSystemSender({ sender_type: 'system' }), true);
});

test('isSystemSender: 嵌套 message.sender_type=SYSTEM 命中（get-message 详情）', () => {
  assert.equal(isSystemSender({ message: { sender_type: 'SYSTEM' } }), true);
});

test('isSystemSender: 人类/agent/缺省都不命中', () => {
  assert.equal(isSystemSender({ sender_type: 'HUMAN' }), false);
  assert.equal(isSystemSender({ sender_type: 'AGENT' }), false);
  assert.equal(isSystemSender({}), false);
  assert.equal(isSystemSender(null), false);
});

test('systemEventPriority: 无 systemEvent 返回 undefined（当前现网系统消息形态）', () => {
  // 目标环境实测：content 仅有 content_type/body，无 metadata。
  assert.equal(
    systemEventPriority({ content: { content_type: 'text', body: { text: '[调度中心] …' } } }),
    undefined,
  );
  assert.equal(systemEventPriority({}), undefined);
});

test('systemEventPriority: urgent/high/normal → 1/2/3', () => {
  const mk = (priority) => ({ content: { metadata: { systemEvent: { priority } } } });
  assert.equal(systemEventPriority(mk('urgent')), 1);
  assert.equal(systemEventPriority(mk('high')), 2);
  assert.equal(systemEventPriority(mk('normal')), 3);
  assert.equal(systemEventPriority(mk('URGENT')), 1);
});

test('systemEventPriority: 顶层 metadata 与 message.content.metadata 两种落点都能读', () => {
  assert.equal(systemEventPriority({ metadata: { systemEvent: { priority: 'high' } } }), 2);
  assert.equal(
    systemEventPriority({ message: { content: { metadata: { systemEvent: { priority: 'urgent' } } } } }),
    1,
  );
});

test('systemEventPriority: systemEvent 存在但 priority 缺省/未知 → 3（normal）', () => {
  assert.equal(systemEventPriority({ content: { metadata: { systemEvent: { eventType: 'task.completed' } } } }), 3);
  assert.equal(systemEventPriority({ content: { metadata: { systemEvent: { priority: 'bogus' } } } }), 3);
});

test('senderMemberFrom: 顶层 HUMAN / AGENT → human / agent（实时 WS 帧），大小写不敏感', () => {
  assert.deepEqual(senderMemberFrom({ sender_type: 'HUMAN', sender_id: 'm-alice' }), { kind: 'human', memberId: 'm-alice' });
  assert.deepEqual(senderMemberFrom({ sender_type: 'human', sender_id: 'm-alice' }), { kind: 'human', memberId: 'm-alice' });
  assert.deepEqual(senderMemberFrom({ sender_type: 'AGENT', sender_id: 'm-bot' }), { kind: 'agent', memberId: 'm-bot' });
  assert.deepEqual(senderMemberFrom({ sender_type: 'Agent', sender_id: 'm-bot' }), { kind: 'agent', memberId: 'm-bot' });
});

test('senderMemberFrom: 嵌套 message.sender_type / message.sender_id（sync 补拉 / 详情）', () => {
  assert.deepEqual(senderMemberFrom({ message: { sender_type: 'HUMAN', sender_id: 'm-alice' } }), { kind: 'human', memberId: 'm-alice' });
  assert.deepEqual(senderMemberFrom({ sender_id: 'm-top', message: { sender_type: 'AGENT', sender_id: 'm-nested' } }), { kind: 'agent', memberId: 'm-top' });
  assert.deepEqual(senderMemberFrom({ sender_type: 'HUMAN', message: { sender_id: 'm-nested' } }), { kind: 'human', memberId: 'm-nested' });
  // Top-level sender_type wins over message.sender_type, as in isSystemSender.
  assert.deepEqual(senderMemberFrom({ sender_type: 'HUMAN', sender_id: 'm-1', message: { sender_type: 'AGENT' } }), { kind: 'human', memberId: 'm-1' });
  assert.deepEqual(senderMemberFrom({ sender_type: 'AGENT', sender_id: 'm-1', message: { sender_type: 'HUMAN' } }), { kind: 'agent', memberId: 'm-1' });
  assert.equal(senderMemberFrom({ sender_type: 'SYSTEM', sender_id: 'm-1', message: { sender_type: 'HUMAN' } }), undefined);
});

test('senderMemberFrom: SYSTEM / 空 / 未知类型 / 缺 id → undefined（不猜 kind）', () => {
  assert.equal(senderMemberFrom({ sender_type: 'SYSTEM', sender_id: 'sys-1' }), undefined);
  assert.equal(senderMemberFrom({ sender_type: '', sender_id: 'm-1' }), undefined);
  assert.equal(senderMemberFrom({ sender_type: 'BOT', sender_id: 'm-1' }), undefined);
  assert.equal(senderMemberFrom({ sender_type: 'toString', sender_id: 'm-1' }), undefined);
  assert.equal(senderMemberFrom({ sender_type: 'constructor', sender_id: 'm-1' }), undefined);
  assert.equal(senderMemberFrom({ sender_id: 'm-1' }), undefined);
  assert.equal(senderMemberFrom({ sender_type: 'HUMAN' }), undefined);
  assert.equal(senderMemberFrom({ sender_type: 'HUMAN', sender_id: '' }), undefined);
  assert.equal(senderMemberFrom({}), undefined);
  assert.equal(senderMemberFrom(null), undefined);
  assert.equal(senderMemberFrom(undefined), undefined);
});
