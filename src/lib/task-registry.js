export default class TaskRegistry {
  #tasks = new Map();

  /**
   * @param {string} name        Unique task identifier
   * @param {Function} fn        Callback invoked on each tick; may be async, in
   *                             which case ticks never overlap (see #invoke)
   * @param {number} intervalMs  Milliseconds between ticks
   * @param {object} [opts]
   * @param {number}  [opts.delay=0]         Delay before the first tick (ms)
   * @param {boolean} [opts.runOnStart=false] Execute fn immediately when started (after delay)
   */
  register(name, fn, intervalMs, { delay = 0, runOnStart = false } = {}) {
    if (this.#tasks.has(name)) throw new Error(`task "${name}" already registered`);
    this.#tasks.set(name, {
      fn, intervalMs, delay, runOnStart, timer: null, delayTimer: null, running: false,
    });
  }

  /**
   * Run one tick of a task, serialized: an async fn whose previous run is still
   * in flight makes this tick a logged no-op rather than a second concurrent
   * run. setInterval does not await anything, so without this a task slower
   * than its own interval (a hung HTTP call, say) accumulates overlapping runs —
   * which for anything that reads-modifies-writes shared state means duplicated
   * side effects and lost writes. Rejections are contained here too: an async
   * fn's rejection would otherwise surface as an unhandledRejection and could
   * take the process down.
   */
  async #invoke(name, t) {
    if (t.running) {
      console.warn(`[tasks] ${name} skipped: previous run still in flight`);
      return;
    }
    t.running = true;
    try {
      await t.fn();
    } catch (err) {
      console.error(`[tasks] ${name} failed: ${err?.message || err}`);
    } finally {
      t.running = false;
    }
  }

  /**
   * Run one tick now, through the same serialized path the interval uses.
   * Returns the run's promise so a caller (or a test) can await it; a tick that
   * lands on a run already in flight resolves immediately as a no-op.
   */
  tickNow(name) {
    const t = this.#tasks.get(name);
    if (!t) return Promise.resolve();
    return this.#invoke(name, t);
  }

  start(name) {
    const t = this.#tasks.get(name);
    if (!t || t.timer || t.delayTimer) return;
    const tick = () => { void this.#invoke(name, t); };
    const begin = () => {
      t.delayTimer = null;
      if (t.runOnStart) tick();
      t.timer = setInterval(tick, t.intervalMs);
      t.timer.unref?.();
    };
    if (t.delay > 0) {
      t.delayTimer = setTimeout(begin, t.delay);
      t.delayTimer.unref?.();
    } else {
      begin();
    }
  }

  /** Whether the task is started (its interval or its first-tick delay is armed). */
  isRunning(name) {
    const t = this.#tasks.get(name);
    return !!(t && (t.timer || t.delayTimer));
  }

  /** Whether a task of this name is registered. */
  has(name) {
    return this.#tasks.has(name);
  }

  startAll() {
    for (const name of this.#tasks.keys()) this.start(name);
  }

  stop(name) {
    const t = this.#tasks.get(name);
    if (!t) return;
    if (t.delayTimer) { clearTimeout(t.delayTimer); t.delayTimer = null; }
    if (t.timer) { clearInterval(t.timer); t.timer = null; }
  }

  stopAll() {
    for (const name of this.#tasks.keys()) this.stop(name);
  }

  list() {
    return [...this.#tasks.entries()].map(([name, t]) => ({
      name,
      intervalMs: t.intervalMs,
      running: !!(t.timer || t.delayTimer),
      inFlight: t.running,
    }));
  }
}
