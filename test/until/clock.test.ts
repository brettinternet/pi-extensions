import { describe, expect, it, vi } from "bun:test";

import { createSystemClock } from "../../extensions/until/clock.ts";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_NATIVE_TIMEOUT_MS = 2_147_483_647;

describe("pi-until system clock", () => {
  it("chunks delays that exceed Node's native timeout limit", () => {
    let now = 0;
    const scheduled: Array<{
      callback: () => void;
      cancelled: boolean;
      delay: number;
    }> = [];
    const completed = vi.fn();
    const clock = createSystemClock({
      now: () => now,
      schedule(callback, delay) {
        const timer = { callback, cancelled: false, delay };
        scheduled.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });

    clock.setTimeout(completed, THIRTY_DAYS_MS);

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delay).toBe(MAX_NATIVE_TIMEOUT_MS);

    now = MAX_NATIVE_TIMEOUT_MS;
    scheduled[0]?.callback();

    expect(completed).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]?.delay).toBe(
      THIRTY_DAYS_MS - MAX_NATIVE_TIMEOUT_MS
    );

    now = THIRTY_DAYS_MS;
    scheduled[1]?.callback();

    expect(completed).toHaveBeenCalledTimes(1);
  });
});
