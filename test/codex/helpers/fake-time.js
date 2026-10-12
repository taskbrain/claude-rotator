// 偽の時計と偽のスケジューラ（Codex 側のテスト用）。読み込んでもテストを登録せず、I/O もしない。
// グローバルのタイマーを差し替えず、node:test の偽のタイマーも使わない。
//
// 提供するのは
// createFakeClock・createFakeScheduler の2つ。
import assert from 'node:assert/strict';

// タイマーの状態は時計が持つ。同じ時計につないだスケジューラは、すべて同じ順番で発火する。
const clocks = new WeakMap();

/** advance は同期で進む。コールバックが返した Promise の続きは流さない（呼び出し側が待つ）。 */
export function createFakeClock({ startMs = 0 } = {}) {
  assert.ok(Number.isFinite(startMs), 'startMs must be finite');
  const state = { now: startMs, timers: new Map(), nextId: 1, advancing: false };
  const clock = {
    now: () => state.now,
    advance(ms) {
      assert.ok(Number.isFinite(ms) && ms >= 0, 'advance must be finite non-negative milliseconds');
      const target = state.now + ms;
      assert.ok(Number.isFinite(target), 'clock target must be finite');
      assert.equal(state.advancing, false, 'nested clock.advance is unsupported');
      state.advancing = true;
      try {
        while (true) {
          let next;
          for (const timer of state.timers.values()) {
            if (timer.at <= target && (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) next = timer;
          }
          if (!next) break;
          state.now = next.at;
          if (next.interval) next.at += next.interval;
          else state.timers.delete(next.id);
          next.callback(...next.args);
        }
        state.now = target;
      } finally { state.advancing = false; }
      return state.now;
    },
  };
  clocks.set(clock, state);
  return clock;
}

/** 遅延は有限で0以上。0 は 1ms に切り上げる。 */
export function createFakeScheduler(clock) {
  const state = clocks.get(clock);
  assert.ok(state, 'scheduler requires a createFakeClock clock');
  function schedule(callback, delay, args, repeating) {
    assert.equal(typeof callback, 'function', 'timer callback must be a function');
    assert.ok(Number.isFinite(delay) && delay >= 0, 'timer delay must be finite non-negative milliseconds');
    const period = Math.max(1, delay);
    const id = state.nextId++;
    state.timers.set(id, { id, at: state.now + period, interval: repeating ? period : 0, callback, args });
    return id;
  }
  return {
    setTimeout: (callback, delay = 0, ...args) => schedule(callback, delay, args, false),
    setInterval: (callback, delay = 0, ...args) => schedule(callback, delay, args, true),
    clearTimeout: id => { state.timers.delete(id); },
    clearInterval: id => { state.timers.delete(id); },
  };
}
