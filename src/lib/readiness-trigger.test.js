import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadinessTrigger, TRIGGER_DEFAULTS } from './readiness-trigger.js';

function makeTrigger({ verdicts, options = {}, startClock = 100_000 } = {}) {
  let i = 0;
  let clock = startClock;
  const reports = [];
  const logs = [];
  const trigger = createReadinessTrigger({
    evaluate: () => verdicts[Math.min(i++, verdicts.length - 1)],
    report: async () => { reports.push(clock); },
    now: () => clock,
    options: () => options,
    log: (m) => logs.push(m),
    warn: (m) => logs.push('WARN ' + m),
  });
  return { trigger, reports, logs, advance: (ms) => { clock += ms; }, clockAt: () => clock };
}

const READY = { ready: true, reason: 'ready' };
const BUSY = { ready: false, reason: 'busy' };
const IDLE_BRIEF = { ready: false, reason: 'idle_too_brief' };
const NO_SESSION = { ready: false, reason: 'no_session' };

test('an asynchronous readiness source preserves the existing stage edge trigger', async () => {
  let verdict = NO_SESSION;
  let reports = 0;
  const trigger = createReadinessTrigger({
    evaluate: async () => { await Promise.resolve(); return verdict; },
    report: async () => { reports++; },
    options: () => ({ minGapMs: 0 }),
  });
  await trigger.tick();
  assert.equal(reports, 0);
  verdict = READY;
  await trigger.tick();
  assert.equal(reports, 1);
  await trigger.tick();
  assert.equal(reports, 1);
});

test('a pending asynchronous probe excludes overlapping samples and releases after failure', async () => {
  let finish, calls = 0, reports = 0;
  const trigger = createReadinessTrigger({
    evaluate: () => {
      calls++;
      if (calls === 1) return new Promise(resolve => { finish = resolve; });
      if (calls === 2) return Promise.reject(new Error('probe failed'));
      return Promise.resolve(READY);
    },
    report: async () => { reports++; }, options: () => ({ minGapMs: 0 }),
  });
  const pending = trigger.tick();
  await trigger.tick();
  assert.equal(calls, 1, 'the existing in-flight guard includes the sample');
  finish(NO_SESSION);
  await pending;
  await assert.rejects(trigger.tick(), /probe failed/);
  await trigger.tick();
  assert.equal(calls, 3);
  assert.equal(reports, 1, 'failed sampling does not leave the trigger locked');
});

test('第一次采样只建立基线，不上报', async () => {
  const { trigger, reports } = makeTrigger({ verdicts: [READY] });
  await trigger.tick();
  assert.deepEqual(reports, []);
});

test('未就绪 → 就绪：立刻上报（这是解禁聊天的关键边）', async () => {
  const { trigger, reports, advance } = makeTrigger({ verdicts: [NO_SESSION, READY] });
  await trigger.tick();          // baseline: not ready
  advance(TRIGGER_DEFAULTS.minGapMs + 1);
  await trigger.tick();          // flips to ready
  assert.equal(reports.length, 1);
});

test('busy ↔ idle 抖动不触发上报（否则干活中的 agent 会持续刷 PUT）', async () => {
  const { trigger, reports, advance } = makeTrigger({
    verdicts: [BUSY, IDLE_BRIEF, BUSY, IDLE_BRIEF, BUSY],
  });
  for (let n = 0; n < 5; n++) { await trigger.tick(); advance(2000); }
  assert.deepEqual(reports, [], 'neither ready nor observable changes, so no report');
});

test('可观测性变化（进程消失/出现）会触发上报', async () => {
  const { trigger, reports, advance } = makeTrigger({ verdicts: [BUSY, NO_SESSION] });
  await trigger.tick();
  advance(TRIGGER_DEFAULTS.minGapMs + 1);
  await trigger.tick();
  assert.equal(reports.length, 1, 'busy→no_session flips observable');
});

test('就绪 → 未就绪也上报（平台要能收回可聊天状态）', async () => {
  const { trigger, reports, advance } = makeTrigger({ verdicts: [READY, BUSY] });
  await trigger.tick();
  advance(TRIGGER_DEFAULTS.minGapMs + 1);
  await trigger.tick();
  assert.equal(reports.length, 1);
});

test('最小间隔内的变化被压住，交给周期 tick，并留日志', async () => {
  const { trigger, reports, logs, advance } = makeTrigger({
    verdicts: [NO_SESSION, READY, BUSY],
    options: { minGapMs: 10_000 },
  });
  await trigger.tick();               // baseline
  advance(20_000);
  await trigger.tick();               // → ready, reports
  assert.equal(reports.length, 1);
  advance(1000);                      // inside the floor
  await trigger.tick();               // → not ready again
  assert.equal(reports.length, 1, 'suppressed by the floor');
  assert.ok(logs.some(l => l.includes('floor')), 'suppression must be visible in logs');
});

test('上报失败只 warn，不抛（周期 tick 是兜底）', async () => {
  let clock = 0;
  const logs = [];
  const trigger = createReadinessTrigger({
    evaluate: (() => { let n = 0; return () => (n++ === 0 ? NO_SESSION : READY); })(),
    report: async () => { throw new Error('network down'); },
    now: () => clock,
    log: (m) => logs.push(m),
    warn: (m) => logs.push('WARN ' + m),
  });
  await trigger.tick();
  clock += 999_999;
  await assert.doesNotReject(() => trigger.tick());
  assert.ok(logs.some(l => l.startsWith('WARN') && l.includes('network down')));
});

test('慢上报期间不叠加第二次', async () => {
  let clock = 0, active = 0, maxActive = 0;
  let n = 0;
  const trigger = createReadinessTrigger({
    evaluate: () => (n++ % 2 === 0 ? NO_SESSION : READY),
    report: async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    },
    now: () => clock,
    options: () => ({ minGapMs: 0 }),
  });
  await trigger.tick();
  clock += 100;
  await Promise.all([trigger.tick(), trigger.tick(), trigger.tick()]);
  assert.equal(maxActive, 1, 'reports must not overlap');
});

test('start/stop 幂等且不泄漏定时器', () => {
  const created = [];
  const cleared = [];
  const trigger = createReadinessTrigger({
    evaluate: () => READY,
    report: async () => {},
    setIntervalImpl: (fn, ms) => { const h = { fn, ms, unref(){} }; created.push(h); return h; },
    clearIntervalImpl: (h) => cleared.push(h),
  });
  trigger.start(); trigger.start();
  assert.equal(created.length, 1, 'second start is a no-op');
  trigger.stop(); trigger.stop();
  assert.equal(cleared.length, 1);
});

// runtime_down → runtime_up 不移动 ready/observable 任何一个 bit，但它是平台
// 四步进度里实实在在的一步。改成比较 stage 之前，这一步要等下一次 60s 周期
// 上报才可见 —— 明明我们在启动后几秒就知道了。
test('stage 变化即使两个 bit 都没动也要补报', async () => {
  const STATUS_MISSING = { ready: false, reason: 'status_missing' }; // runtime_down
  const NO_SESSION_V = { ready: false, reason: 'no_session' };       // runtime_up
  const { trigger, reports, advance } = makeTrigger({
    verdicts: [STATUS_MISSING, NO_SESSION_V],
    options: { minGapMs: 0 },
  });
  await trigger.tick();          // 基线
  advance(10_000);
  await trigger.tick();          // runtime_down → runtime_up
  assert.equal(reports.length, 1, 'stage 前进必须补报');
});

// 反过来：同一档内的抖动一次都不能报。干活的 agent 在 busy 和 idle 之间
// 反复横跳，两者同属 session_ready。
test('busy ↔ idle_too_brief 同属 session_ready，不产生任何补报', async () => {
  const { trigger, reports, advance } = makeTrigger({
    verdicts: [BUSY, IDLE_BRIEF, BUSY, IDLE_BRIEF, BUSY],
    options: { minGapMs: 0 },
  });
  await trigger.tick();
  for (let i = 0; i < 4; i++) { advance(10_000); await trigger.tick(); }
  assert.deepEqual(reports, [], '同档抖动必须完全静默');
});

test('runtime_up → session_ready → ready 每一步各补报一次', async () => {
  const { trigger, reports, advance } = makeTrigger({
    verdicts: [NO_SESSION, BUSY, READY],
    options: { minGapMs: 0 },
  });
  await trigger.tick();          // 基线 runtime_up
  advance(10_000); await trigger.tick();  // → session_ready
  advance(10_000); await trigger.tick();  // → ready
  assert.equal(reports.length, 2);
});

// ── 配置归一化（CHANGELOG 记的是 poll_ms / min_gap_ms） ────────────────────

// 这个 bug 在 agent-readiness.js 里已经犯过一次并修好了，trigger 又原样重犯：
// 把原始 config 直接并进 camelCase 默认值，于是**每一个文档里写着的旋钮都被
// 静默忽略**，默认值继续生效，还没有任何报错能说明为什么。
test('snake_case 的 poll_ms / min_gap_ms 必须生效', () => {
  const seen = [];
  const trigger = createReadinessTrigger({
    evaluate: () => READY,
    report: async () => {},
    options: () => ({ poll_ms: 123, min_gap_ms: 456 }),
    setIntervalImpl: (fn, ms) => { seen.push(ms); return { unref() {} }; },
  });
  trigger.start();
  assert.deepEqual(seen, [123], 'poll_ms 应当覆盖默认的 2000ms');
});

test('camelCase 同样接受（程序化调用方/ 测试）', () => {
  const seen = [];
  const trigger = createReadinessTrigger({
    evaluate: () => READY,
    report: async () => {},
    options: () => ({ pollMs: 321 }),
    setIntervalImpl: (fn, ms) => { seen.push(ms); return { unref() {} }; },
  });
  trigger.start();
  assert.deepEqual(seen, [321]);
});

// 非法值不能传播：NaN 的 pollMs 会把轮询变成忙等。
test('非数值 / 非正数一律忽略，回落到默认值', () => {
  for (const bad of [{ poll_ms: 'abc' }, { poll_ms: 0 }, { poll_ms: -5 }, { poll_ms: null }]) {
    const seen = [];
    const trigger = createReadinessTrigger({
      evaluate: () => READY,
      report: async () => {},
      options: () => bad,
      setIntervalImpl: (fn, ms) => { seen.push(ms); return { unref() {} }; },
    });
    trigger.start();
    assert.deepEqual(seen, [TRIGGER_DEFAULTS.pollMs], `${JSON.stringify(bad)} 应当回落默认值`);
  }
});

// min_gap_ms 走的是另一条路径（补报节流），单独钉一次。
test('min_gap_ms 生效：低于间隔的第二次变化只记日志不上报', async () => {
  const { trigger, reports, logs, advance } = makeTrigger({
    verdicts: [NO_SESSION, BUSY, READY],
    options: { min_gap_ms: 100_000 },
  });
  await trigger.tick();          // 基线
  advance(1000); await trigger.tick();  // 第一次变化 → 补报
  advance(1000); await trigger.tick();  // 仍在间隔内 → 只记日志
  assert.equal(reports.length, 1);
  assert.ok(logs.some((l) => l.includes('floor')), '被抑制的补报必须留下日志');
});

// minGapMs = 0 是「不设下限」这个真实配置，不能被当成非法值丢掉；而 pollMs = 0
// 会把 watcher 变成忙等，必须丢掉。两者的 0 含义不同。
test('minGapMs 允许为 0，pollMs 不允许', () => {
  const seenGap = [];
  const t1 = createReadinessTrigger({
    evaluate: () => READY, report: async () => {},
    options: () => ({ min_gap_ms: 0 }),
    setIntervalImpl: (fn, ms) => { seenGap.push(ms); return { unref() {} }; },
  });
  t1.start();
  assert.deepEqual(seenGap, [TRIGGER_DEFAULTS.pollMs], 'min_gap_ms 不影响轮询间隔');

  const seenPoll = [];
  const t2 = createReadinessTrigger({
    evaluate: () => READY, report: async () => {},
    options: () => ({ poll_ms: 0 }),
    setIntervalImpl: (fn, ms) => { seenPoll.push(ms); return { unref() {} }; },
  });
  t2.start();
  assert.deepEqual(seenPoll, [TRIGGER_DEFAULTS.pollMs], 'poll_ms=0 必须回落默认值');
});
