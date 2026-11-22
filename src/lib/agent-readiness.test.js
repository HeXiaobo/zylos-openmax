import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadinessGate, createGatedOnlineReporter, formatReadinessDetail, normalizeReadinessOptions, READINESS_DEFAULTS, stageForReason, readinessReport } from './agent-readiness.js';

const NOW = 1_700_000_000_000;
const LAUNCH_AT = NOW - 60_000;

function readyStatus(overrides = {}) {
  return {
    data: {
      state: 'idle',
      health: 'ok',
      idle_seconds: 30,
      runtime_launch_at: LAUNCH_AT,
      ...overrides,
    },
    mtimeMs: NOW,
  };
}

/**
 * Clock advances by pollMs on every sleep so wait loops terminate deterministically
 * without real timers.
 */
function makeGate({ status = readyStatus(), foreground = { observed_at: LAUNCH_AT + 1000 }, proc = { alive: true }, options = {}, runtime, codexSession } = {}) {
  let clock = NOW;
  const sleeps = [];
  const codexCalls = [];
  const deps = {
    readStatus: () => (typeof status === 'function' ? status(clock) : status),
    readForeground: () => (typeof foreground === 'function' ? foreground(clock) : foreground),
    readProc: () => proc,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    options: () => options,
  };
  // Only inject the Codex deps when a test asks for them, so every pre-existing
  // test still exercises the gate exactly as callers without them do.
  if (runtime !== undefined) deps.readRuntime = () => runtime;
  if (codexSession !== undefined) {
    deps.readCodexSession = (args) => {
      codexCalls.push(args);
      return typeof codexSession === 'function' ? codexSession(clock) : codexSession;
    };
  }
  const gate = createReadinessGate(deps);
  return { gate, sleeps, clockAt: () => clock, codexCalls };
}

test('idle + 本轮 launch 内有 session_start ⇒ ready', () => {
  const { gate } = makeGate();
  const v = gate.evaluate();
  assert.equal(v.ready, true);
  assert.equal(v.reason, 'ready');
});

test('busy ⇒ not ready', () => {
  const { gate } = makeGate({ status: readyStatus({ state: 'busy' }) });
  assert.equal(gate.evaluate().reason, 'busy');
});

test('idle 但还没有任何 session ⇒ not ready（这是 raw idle 会漏掉的启动窗口）', () => {
  const { gate } = makeGate({ foreground: null });
  const v = gate.evaluate();
  assert.equal(v.ready, false);
  assert.equal(v.reason, 'no_session');
});

test('session_start 早于本轮 runtime_launch_at ⇒ 视为上一轮的残留，not ready', () => {
  const { gate } = makeGate({ foreground: { observed_at: LAUNCH_AT - 5000 } });
  assert.equal(gate.evaluate().reason, 'session_predates_launch');
});

test('idle 时间不足 minIdleSeconds ⇒ not ready', () => {
  const { gate } = makeGate({ status: readyStatus({ idle_seconds: 1 }) });
  assert.equal(gate.evaluate().reason, 'idle_too_brief');
});

test('多个条件同时不满足时，报最根本的那个（启动期报 no_session，不报 idle_too_brief）', () => {
  // Boot window: idle reading exists but no session at all — remote log readers
  // must see the real blocker, not the incidental one.
  const { gate } = makeGate({ status: readyStatus({ idle_seconds: 0 }), foreground: null });
  assert.equal(gate.evaluate().reason, 'no_session');
});

test('proc 已死优先于 busy 报出（idle/busy 读数此时无意义）', () => {
  const { gate } = makeGate({ status: readyStatus({ state: 'busy' }), proc: { alive: false } });
  assert.equal(gate.evaluate().reason, 'runtime_dead');
});

test('status 文件缺失或过期 ⇒ not ready（monitor 没在写，状态未知）', () => {
  assert.equal(makeGate({ status: null }).gate.evaluate().reason, 'status_missing');
  const stale = { ...readyStatus(), mtimeMs: NOW - READINESS_DEFAULTS.staleStatusMs - 1 };
  assert.equal(makeGate({ status: stale }).gate.evaluate().reason, 'status_stale');
});

test('health 非 ok ⇒ not ready，且 reason 带上具体 health', () => {
  const { gate } = makeGate({ status: readyStatus({ health: 'down' }) });
  assert.equal(gate.evaluate().reason, 'health_down');
});

test('proc 明确 alive=false ⇒ not ready（idle 读数无意义）', () => {
  const { gate } = makeGate({ proc: { alive: false } });
  assert.equal(gate.evaluate().reason, 'runtime_dead');
});

test('proc-state 缺失时不阻塞（advisory only）', () => {
  const { gate } = makeGate({ proc: null });
  assert.equal(gate.evaluate().ready, true);
});

test('waitUntilReady 轮询到 ready 后返回等待时长', async () => {
  let ticks = 0;
  const { gate } = makeGate({
    status: () => (ticks++ < 2 ? readyStatus({ state: 'busy' }) : readyStatus()),
    options: { pollMs: 1000 },
  });
  const v = await gate.waitUntilReady();
  assert.equal(v.ready, true);
  assert.equal(v.timedOut, false);
  assert.equal(v.waitedMs, 2000);
});

test('永远不 ready ⇒ 到 maxWaitMs 后 timedOut 返回（fail-open，绝不无限等）', async () => {
  const { gate } = makeGate({
    status: readyStatus({ state: 'busy' }),
    options: { pollMs: 1000, maxWaitMs: 5000 },
  });
  const v = await gate.waitUntilReady();
  assert.equal(v.ready, false);
  assert.equal(v.timedOut, true);
  assert.equal(v.reason, 'busy');
  assert.ok(v.waitedMs <= 5000, `waited ${v.waitedMs} must not exceed the cap`);
});

// --- public config shape (agent.readiness_gate) -----------------------------
// Regression: the documented snake_case knobs were merged raw into camelCase
// defaults, so every timing setting was silently ignored — an operator lowering
// max_wait_ms still waited the full 10-minute default.

test('公开配置是 snake_case，必须真正生效（回归：曾被静默忽略）', async () => {
  const { gate } = makeGate({
    status: readyStatus({ state: 'busy' }),
    options: { poll_ms: 100, max_wait_ms: 300, heartbeat_ms: 100, min_idle_seconds: 9, stale_status_ms: 60_000 },
  });
  const v = await gate.waitUntilReady();
  assert.equal(v.timedOut, true);
  assert.ok(v.waitedMs <= 300, `max_wait_ms 必须生效，实际等了 ${v.waitedMs}ms`);
});

test('snake_case min_idle_seconds 生效（默认 5 时 idle=7 本应 ready）', () => {
  const { gate } = makeGate({ status: readyStatus({ idle_seconds: 7 }), options: { min_idle_seconds: 30 } });
  assert.equal(gate.evaluate().reason, 'idle_too_brief');
});

test('snake_case stale_status_ms 生效', () => {
  const stale = { ...readyStatus(), mtimeMs: NOW - 5000 };
  assert.equal(makeGate({ status: stale, options: { stale_status_ms: 60_000 } }).gate.evaluate().ready, true);
  assert.equal(makeGate({ status: stale, options: { stale_status_ms: 1000 } }).gate.evaluate().reason, 'status_stale');
});

test('normalizeReadinessOptions: snake_case → camelCase 全量映射', () => {
  assert.deepEqual(
    normalizeReadinessOptions({
      min_idle_seconds: 1, poll_ms: 2, max_wait_ms: 3, stale_status_ms: 4, heartbeat_ms: 5,
    }),
    { minIdleSeconds: 1, pollMs: 2, maxWaitMs: 3, staleStatusMs: 4, heartbeatMs: 5 },
  );
  // every default must have a documented snake_case spelling — no silent gaps
  for (const key of Object.keys(READINESS_DEFAULTS)) {
    const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    assert.ok(snake in { min_idle_seconds: 1, poll_ms: 1, max_wait_ms: 1, stale_status_ms: 1, heartbeat_ms: 1 },
      `default ${key} has no snake_case alias (${snake})`);
  }
});

test('normalizeReadinessOptions: camelCase 仍接受（程序内/测试调用）', () => {
  assert.deepEqual(normalizeReadinessOptions({ pollMs: 50 }), { pollMs: 50 });
});

test('normalizeReadinessOptions: 无效值和无关键忽略，不污染默认值', () => {
  assert.deepEqual(normalizeReadinessOptions({ enabled: false, poll_ms: 'abc', max_wait_ms: 0, nope: 1 }), {});
  assert.deepEqual(normalizeReadinessOptions(null), {});
  assert.deepEqual(normalizeReadinessOptions('x'), {});
});

test('配置里的垃圾值不会让轮询退化成忙等或取消 fail-open 上限', async () => {
  const { gate, sleeps } = makeGate({
    status: readyStatus({ state: 'busy' }),
    options: { poll_ms: 'oops', max_wait_ms: NaN },
  });
  const v = await gate.waitUntilReady();
  assert.equal(v.timedOut, true);
  assert.equal(v.waitedMs, READINESS_DEFAULTS.maxWaitMs, 'falls back to the default cap, and never overshoots it');
  assert.ok(sleeps.every((ms) => ms === READINESS_DEFAULTS.pollMs), 'must fall back to the default poll interval');
});

// --- gated reporter ---------------------------------------------------------

function fakeGate(verdict) {
  let release;
  const gate = {
    calls: 0,
    waitUntilReady: async () => {
      gate.calls++;
      if (verdict === 'hang') return new Promise((r) => { release = () => r({ ready: true, reason: 'ready', waitedMs: 1, timedOut: false }); });
      return verdict;
    },
    release: () => release?.(),
  };
  return gate;
}

test('gated reporter: ready 后才发 online-report', async () => {
  const gate = fakeGate({ ready: true, reason: 'ready', waitedMs: 4000, timedOut: false });
  const posts = [];
  const report = createGatedOnlineReporter({ reportAgentOnline: async (o) => posts.push(o.slug), gate });
  await report({ slug: 'org-a' });
  assert.deepEqual(posts, ['org-a']);
});

// Regression for the 2026-08-10 cws-agent-runtime finding: a transient
// prepare-phase comm-bridge must never produce an online-report, because the
// platform treats it as proof the real runtime is up and fires the welcome DM.
test('到达上限但压根没有 session ⇒ 绝不上报（no_session 不 fail-open）', async () => {
  const { gate } = makeGate({
    status: readyStatus({ state: 'idle', idle_seconds: 99 }),
    foreground: null, // prepare phase: no agent session has ever started
    options: { pollMs: 1000, maxWaitMs: 3000 },
  });
  const v = await gate.waitUntilReady();
  assert.equal(v.timedOut, true);
  assert.equal(v.reason, 'no_session');
  assert.equal(v.failOpenAllowed, false, 'reporting here would assert something untrue');
});

test('上一轮残留的 session 同样不 fail-open（等价于本轮没有 session）', async () => {
  const { gate } = makeGate({
    foreground: { observed_at: LAUNCH_AT - 1 },
    options: { pollMs: 1000, maxWaitMs: 3000 },
  });
  const v = await gate.waitUntilReady();
  assert.equal(v.reason, 'session_predates_launch');
  assert.equal(v.failOpenAllowed, false);
});

test('busy 仍然 fail-open（agent 存在，只是忙 ⇒ 不能把 org 永久卡住）', async () => {
  const { gate } = makeGate({
    status: readyStatus({ state: 'busy' }),
    options: { pollMs: 1000, maxWaitMs: 3000 },
  });
  const v = await gate.waitUntilReady();
  assert.equal(v.reason, 'busy');
  assert.notEqual(v.failOpenAllowed, false, 'a present-but-busy agent must still report');
});

test('gated reporter: no_session 到上限时不发报告（而不是发一个假的）', async () => {
  const gate = fakeGate({ ready: false, reason: 'no_session', detail: {}, waitedMs: 600000, timedOut: true, failOpenAllowed: false });
  const posts = [];
  const warns = [];
  const report = createGatedOnlineReporter({
    reportAgentOnline: async (o) => posts.push(o.slug), gate, warn: (m) => warns.push(m),
  });
  await report({ slug: 'org-a' });
  assert.deepEqual(posts, [], 'must NOT report a false online');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /NOT reporting online/);
});

test('gated reporter: 等待超时也要发（fail-open），并 warn', async () => {
  const gate = fakeGate({ ready: false, reason: 'busy', waitedMs: 600000, timedOut: true });
  const posts = [];
  const warns = [];
  const report = createGatedOnlineReporter({
    reportAgentOnline: async (o) => posts.push(o.slug), gate, warn: (m) => warns.push(m),
  });
  await report({ slug: 'org-a' });
  assert.deepEqual(posts, ['org-a'], 'timeout must still report — never strand the org');
  assert.equal(warns.length, 1);
});

test('gated reporter: 同一 org 已有 waiter 时第二次调用直接跳过（periodicSync 不叠加轮询）', async () => {
  const gate = fakeGate('hang');
  const posts = [];
  const report = createGatedOnlineReporter({ reportAgentOnline: async (o) => posts.push(o.slug), gate });
  const first = report({ slug: 'org-a' });
  await report({ slug: 'org-a' });           // periodic tick while first is waiting
  assert.equal(gate.calls, 1, 'second call must not start a second wait');
  assert.deepEqual(posts, []);
  gate.release();
  await first;
  assert.deepEqual(posts, ['org-a']);
});

test('gated reporter: waiter 结束后可再次进入（不会永久占位）', async () => {
  const gate = fakeGate({ ready: true, reason: 'ready', waitedMs: 0, timedOut: false });
  const posts = [];
  const report = createGatedOnlineReporter({ reportAgentOnline: async (o) => posts.push(o.slug), gate });
  await report({ slug: 'org-a' });
  await report({ slug: 'org-a' });
  assert.equal(gate.calls, 2);
  assert.deepEqual(posts, ['org-a', 'org-a']);
});

test('gated reporter: 已上报过的 org 直接跳过，不进 gate（重连不再白等）', async () => {
  const gate = fakeGate('hang');
  const posts = [];
  const report = createGatedOnlineReporter({
    reportAgentOnline: async (o) => posts.push(o.slug),
    gate,
    isAlreadyReported: (slug) => slug === 'org-done',
  });
  await report({ slug: 'org-done' });
  assert.equal(gate.calls, 0, 'must not even start a readiness wait for a no-op');
  assert.deepEqual(posts, []);
  // A different org is unaffected.
  const other = report({ slug: 'org-a' });
  assert.equal(gate.calls, 1);
  gate.release();
  await other;
});

test('gated reporter: 配置关闭时绕过 gate 直接发', async () => {
  const gate = fakeGate('hang');
  const posts = [];
  const report = createGatedOnlineReporter({
    reportAgentOnline: async (o) => posts.push(o.slug), gate, isDisabled: () => true,
  });
  await report({ slug: 'org-a' });
  assert.equal(gate.calls, 0);
  assert.deepEqual(posts, ['org-a']);
});

// --- logging contract (this gate is diagnosed from logs on remote machines) ---

test('onWait 同一 reason 不刷屏：心跳间隔内只报一次', async () => {
  const seen = [];
  const { gate } = makeGate({
    status: readyStatus({ state: 'busy' }),
    options: { pollMs: 1000, maxWaitMs: 5000, heartbeatMs: 60_000 },
  });
  await gate.waitUntilReady({ onWait: (e) => seen.push(e) });
  assert.equal(seen.length, 1, 'heartbeat 远大于总等待时长时只应有首次那一条');
  assert.equal(seen[0].kind, 'blocked');
  assert.equal(seen[0].reason, 'busy');
});

test('长时间阻塞时按心跳节奏续报，日志不会静默', async () => {
  const { gate } = makeGate({
    status: readyStatus({ state: 'busy' }),
    options: { pollMs: 1000, maxWaitMs: 10_000, heartbeatMs: 3000 },
  });
  const seen = [];
  await gate.waitUntilReady({ onWait: (e) => seen.push(e) });
  assert.ok(seen.length >= 3, `expected repeated heartbeats, got ${seen.length}`);
  assert.equal(seen[0].kind, 'blocked');
  assert.ok(seen.slice(1).every((e) => e.kind === 'still_blocked'));
  assert.ok(seen.at(-1).waitedMs > seen[0].waitedMs, 'heartbeat 必须带上递增的已等待时长');
});

test('reason 变化时立即续报（不等心跳）', async () => {
  let ticks = 0;
  const { gate } = makeGate({
    status: () => (ticks++ === 0 ? readyStatus({ state: 'busy' }) : readyStatus({ idle_seconds: 1 })),
    options: { pollMs: 1000, maxWaitMs: 4000, heartbeatMs: 999_999 },
  });
  const seen = [];
  await gate.waitUntilReady({ onWait: (e) => seen.push(e) });
  assert.deepEqual(seen.map((e) => e.reason), ['busy', 'idle_too_brief']);
});

test('onWait 带完整快照，能直接看出是哪个条件没过', async () => {
  const { gate } = makeGate({
    status: readyStatus({ state: 'busy', idle_seconds: 0 }),
    options: { pollMs: 1000, maxWaitMs: 2000 },
  });
  const seen = [];
  await gate.waitUntilReady({ onWait: (e) => seen.push(e) });
  const d = seen[0].detail;
  assert.equal(d.state, 'busy');
  assert.equal(d.health, 'ok');
  assert.equal(d.session_in_launch, true);
  assert.equal(d.proc_alive, true);
});

test('formatReadinessDetail 输出可 grep 的单行字段', () => {
  const { gate } = makeGate({ status: readyStatus({ state: 'busy' }) });
  const line = formatReadinessDetail(gate.evaluate().detail);
  assert.match(line, /state=busy/);
  assert.match(line, /health=ok/);
  assert.match(line, /session=in-launch/);
  assert.match(line, /proc=alive/);
});

test('formatReadinessDetail: 状态文件缺失时也要有可读输出', () => {
  const { gate } = makeGate({ status: null });
  assert.equal(formatReadinessDetail(gate.evaluate().detail), 'status_file=missing_or_unreadable');
});

test('session 早于 launch 时快照标记 predates-launch', () => {
  const { gate } = makeGate({ foreground: { observed_at: LAUNCH_AT - 1 } });
  const v = gate.evaluate();
  assert.equal(v.detail.session_in_launch, false);
  assert.match(formatReadinessDetail(v.detail), /session=predates-launch/);
});

// ── stage 阶梯（平台的四步开通进度直接消费它） ──────────────────────────

test('stageForReason: 每个 reason 落在正确的档位', () => {
  const expected = {
    status_missing: 'runtime_down',
    status_stale: 'runtime_down',
    health_degraded: 'runtime_down',
    no_session: 'runtime_up',
    session_predates_launch: 'runtime_up',
    runtime_dead: 'runtime_up',
    busy: 'session_ready',
    idle_too_brief: 'session_ready',
    ready: 'ready',
  };
  for (const [reason, stage] of Object.entries(expected)) {
    assert.equal(stageForReason(reason), stage, `${reason} 应落在 ${stage}`);
  }
});

// 未知 reason 必须落到最低档，而不是被当成"更靠前"的进度。新增一个 blocker
// 却忘了登记，宁可让进度停住，也不能让它悄悄前进 —— 前进是不可撤销的：
// 平台对每一档写一次时间戳，错误地前进一档就再也收不回来。
test('stageForReason: 未登记的 reason 保守落到 runtime_down', () => {
  assert.equal(stageForReason('some_future_blocker'), 'runtime_down');
  assert.equal(stageForReason(''), 'runtime_down');
  assert.equal(stageForReason(undefined), 'runtime_down');
});

test('readinessReport: ready 判定以 verdict.ready 为准，不靠 reason 猜', () => {
  // reason 说 ready 但 ready 标志为假 —— 以标志为准，宁可不放行。
  const r = readinessReport({ ready: false, reason: 'ready' });
  assert.equal(r.ready, false, 'ready 必须来自 verdict.ready');
  assert.equal(r.stage, 'ready', 'stage 仍按 reason 映射');
});

test('readinessReport: observable 覆盖 session_ready 及以上', () => {
  assert.equal(readinessReport({ ready: false, reason: 'busy' }).observable, true);
  assert.equal(readinessReport({ ready: true, reason: 'ready' }).observable, true);
  assert.equal(readinessReport({ ready: false, reason: 'no_session' }).observable, false);
  assert.equal(readinessReport({ ready: false, reason: 'status_missing' }).observable, false);
});

// 缺 verdict 时不能编一个乐观结论出来。
test('readinessReport: 没有 verdict 时落到最低档且不 ready', () => {
  const r = readinessReport(null);
  assert.equal(r.ready, false);
  assert.equal(r.observable, false);
  assert.equal(r.stage, 'runtime_down');
  assert.equal(r.reason, 'status_missing');
});

// ── Codex runtime：foreground-session.json 只由 Claude 的 hook 写 ─────────────
// Codex 上用 rollout session_meta 作为“本轮 launch 有 session”的证据，其余不变。

const codexThread = (startedAt, id = 'thread-1') => ({ session_id: id, started_at: startedAt });

test('codex: 本轮 launch 内有前台 thread + idle 足够久 ⇒ ready', () => {
  const { gate, codexCalls } = makeGate({ runtime: 'codex', foreground: null, codexSession: codexThread(LAUNCH_AT + 2000) });
  const v = gate.evaluate();
  assert.equal(v.ready, true);
  assert.equal(v.reason, 'ready');
  assert.equal(v.detail.session_in_launch, true);
  assert.equal(v.detail.session_id, 'thread-1');
  assert.equal(v.detail.session_source, 'codex_rollout');
  assert.deepEqual(codexCalls, [{ launchAt: LAUNCH_AT }]);
  assert.equal(readinessReport(v).stage, 'ready');
});

test('codex: 本轮 launch 内有 thread 但 busy ⇒ busy / session_ready', () => {
  const { gate } = makeGate({ runtime: 'codex', foreground: null, status: readyStatus({ state: 'busy', idle_seconds: 0 }), codexSession: codexThread(LAUNCH_AT + 2000) });
  const v = gate.evaluate();
  assert.equal(v.reason, 'busy');
  assert.equal(readinessReport(v).stage, 'session_ready');
});

test('codex: idle 不够久 ⇒ idle_too_brief', () => {
  const { gate } = makeGate({ runtime: 'codex', foreground: null, status: readyStatus({ idle_seconds: 1 }), codexSession: codexThread(LAUNCH_AT + 2000) });
  assert.equal(gate.evaluate().reason, 'idle_too_brief');
});

test('codex: 只有早于本轮 launch 的 thread ⇒ session_predates_launch（不 fail-open）', () => {
  const { gate } = makeGate({ runtime: 'codex', foreground: null, codexSession: codexThread(LAUNCH_AT - 5000) });
  const v = gate.evaluate();
  assert.equal(v.reason, 'session_predates_launch');
  assert.equal(v.detail.session_in_launch, false);
  assert.match(formatReadinessDetail(v.detail), /session=predates-launch .*runtime=codex session_source=codex_rollout/);
});

test('codex: 没有任何 thread ⇒ no_session', () => {
  const { gate } = makeGate({ runtime: 'codex', foreground: null, codexSession: null });
  const v = gate.evaluate();
  assert.equal(v.reason, 'no_session');
  assert.equal(v.detail.session_source, 'none');
});

test('codex: 上一轮 Claude 残留的 foreground 记录 + 旧 thread ⇒ 仍是 session_predates_launch', () => {
  const { gate } = makeGate({ runtime: 'codex', foreground: { observed_at: LAUNCH_AT - 9000, session_id: 'claude-old' }, codexSession: codexThread(LAUNCH_AT - 5000) });
  assert.equal(gate.evaluate().reason, 'session_predates_launch');
});

test('codex: 上一轮 Claude 残留的 foreground 记录不挡住本轮的 codex thread', () => {
  const { gate } = makeGate({ runtime: 'codex', foreground: { observed_at: LAUNCH_AT - 9000, session_id: 'claude-old' }, codexSession: codexThread(LAUNCH_AT + 2000, 'codex-new') });
  const v = gate.evaluate();
  assert.equal(v.reason, 'ready');
  assert.equal(v.detail.session_id, 'codex-new');
});

test('codex: 进程已死 ⇒ runtime_dead（绝不把 thread 记在死进程头上）', () => {
  const { gate } = makeGate({ runtime: 'codex', foreground: null, proc: { alive: false }, codexSession: codexThread(LAUNCH_AT + 2000) });
  const v = gate.evaluate();
  assert.equal(v.reason, 'runtime_dead');
  assert.equal(readinessReport(v).stage, 'runtime_up');
});

test('codex: status 过期 / health 非 ok 仍然先拦住', () => {
  const stale = makeGate({ runtime: 'codex', foreground: null, status: { ...readyStatus(), mtimeMs: NOW - 60_000 }, codexSession: codexThread(LAUNCH_AT + 2000) });
  assert.equal(stale.gate.evaluate().reason, 'status_stale');
  const unhealthy = makeGate({ runtime: 'codex', foreground: null, status: readyStatus({ health: 'rate_limited' }), codexSession: codexThread(LAUNCH_AT + 2000) });
  assert.equal(unhealthy.gate.evaluate().reason, 'health_rate_limited');
});

test('codex: 本轮有效的 foreground 记录优先，不去扫 rollout', () => {
  const { gate, codexCalls } = makeGate({ runtime: 'codex', codexSession: codexThread(LAUNCH_AT + 2000) });
  const v = gate.evaluate();
  assert.equal(v.reason, 'ready');
  assert.deepEqual(codexCalls, []);
  assert.equal(v.detail.session_source, undefined);
});

test('codex: 没有 session 到上限 ⇒ 不上报 online（NO_FAIL_OPEN 不变）', async () => {
  const { gate } = makeGate({ runtime: 'codex', foreground: null, codexSession: null, options: { maxWaitMs: 6000 } });
  const v = await gate.waitUntilReady();
  assert.equal(v.timedOut, true);
  assert.equal(v.failOpenAllowed, false);
});

test('codex: thread 在等待中出现 ⇒ waitUntilReady 变 ready', async () => {
  const { gate } = makeGate({ runtime: 'codex', foreground: null, codexSession: (clock) => (clock >= NOW + 4000 ? codexThread(NOW + 3000) : null) });
  const v = await gate.waitUntilReady();
  assert.equal(v.ready, true);
  assert.equal(v.timedOut, false);
});

test('claude runtime: 不读 codex 证据，verdict 与快照与旧行为完全一致', () => {
  for (const runtime of ['claude', null, 'something-else']) {
    const { gate, codexCalls } = makeGate({ runtime, foreground: null, codexSession: codexThread(LAUNCH_AT + 2000) });
    const v = gate.evaluate();
    assert.equal(v.reason, 'no_session');
    assert.deepEqual(codexCalls, []);
    const legacy = makeGate({ foreground: null }).gate.evaluate();
    assert.deepEqual(v.detail, legacy.detail);
    assert.equal(formatReadinessDetail(v.detail), formatReadinessDetail(legacy.detail));
  }
});

test('claude runtime: 旧 foreground 记录 ⇒ 仍是 session_predates_launch，快照不多字段', () => {
  const { gate } = makeGate({ runtime: 'claude', foreground: { observed_at: LAUNCH_AT - 1, session_id: 's' }, codexSession: codexThread(LAUNCH_AT + 2000) });
  const v = gate.evaluate();
  assert.equal(v.reason, 'session_predates_launch');
  assert.deepEqual(Object.keys(v.detail), ['state', 'idle_seconds', 'health', 'status_age_ms', 'session_observed_at', 'runtime_launch_at', 'session_in_launch', 'proc_alive', 'session_id']);
});

test('Core 1 readiness uses an async source without consulting any legacy session evidence', async () => {
  const unavailable = () => { throw new Error('legacy source must not be read'); };
  const gate = createReadinessGate({
    readCoreVersion: () => '1.0.0-beta.8',
    readDashboardReadiness: async () => ({ ready: true, reason: 'ready', detail: {} }),
    readStatus: unavailable, readForeground: unavailable, readProc: unavailable,
    readRuntime: unavailable, readCodexSession: unavailable,
    now: () => NOW, sleep: unavailable,
  });
  assert.equal((await gate.evaluate()).ready, true);
  assert.equal((await gate.waitUntilReady()).timedOut, false);
});

test('unknown Core version does not fall back to stale legacy files', () => {
  const gate = createReadinessGate({ readCoreVersion: () => null,
    readStatus: () => { throw new Error('must not read legacy status'); } });
  assert.deepEqual(readinessReport(gate.evaluate()), {
    ready: false, observable: false, stage: 'runtime_down', reason: 'core_version_unknown',
  });
});

test('an onboarding blocker delays only onboarding and retains the existing fail-open cap', async () => {
  let clock = NOW;
  const gate = createReadinessGate({
    readCoreVersion: () => '1.0.0',
    readDashboardReadiness: async () => ({ ready: true, reason: 'ready',
      onboardingReason: 'health_auth_failed', detail: {} }),
    now: () => clock, sleep: async ms => { clock += ms; },
    options: () => ({ maxWaitMs: 5, pollMs: 2 }),
  });
  assert.deepEqual(readinessReport(await gate.evaluate()), {
    ready: true, observable: true, stage: 'ready', reason: 'ready',
  });
  const result = await gate.waitUntilReady();
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'health_auth_failed');
  assert.equal(result.timedOut, true);
  assert.equal(result.failOpenAllowed, true);
});
