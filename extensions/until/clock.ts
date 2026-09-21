export interface UntilClock {
  readonly clearTimeout: (handle: number) => void;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => number;
}

const MAX_NATIVE_TIMEOUT_MS = 2_147_483_647;

interface TimerRuntime {
  readonly now: () => number;
  readonly schedule: (callback: () => void, delay: number) => () => void;
}

const nativeTimerRuntime: TimerRuntime = {
  now: Date.now,
  schedule(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export const createSystemClock = (
  runtime: TimerRuntime = nativeTimerRuntime
): UntilClock => {
  let nextTimerId = 0;
  const timers = new Map<
    number,
    { callback: () => void; cancel?: () => void; deadline: number }
  >();

  const scheduleNextChunk = (id: number): void => {
    const timer = timers.get(id);
    if (timer === undefined) return;
    const remaining = Math.max(0, timer.deadline - runtime.now());
    timer.cancel = runtime.schedule(
      () => {
        const current = timers.get(id);
        if (current === undefined) return;
        if (current.deadline > runtime.now()) {
          scheduleNextChunk(id);
          return;
        }
        timers.delete(id);
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Clock scheduling is a callback API.
        current.callback();
      },
      Math.min(remaining, MAX_NATIVE_TIMEOUT_MS)
    );
  };

  return {
    clearTimeout(handle) {
      const timer = timers.get(handle);
      if (timer === undefined) return;
      timers.delete(handle);
      timer.cancel?.();
    },
    now: runtime.now,
    setTimeout(callback, delay) {
      nextTimerId += 1;
      const id = nextTimerId;
      timers.set(id, {
        callback,
        deadline: runtime.now() + Math.max(0, delay),
      });
      scheduleNextChunk(id);
      return id;
    },
  };
};

export const systemClock = createSystemClock();
