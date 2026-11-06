import { useEffect } from "react";

/** Returns whether the polling effect is still mounted (safe to update state). */
export type PollingIsActive = () => boolean;

export type UsePollingOptions = {
  intervalMs: number;
  onPoll: (isActive: PollingIsActive) => void | Promise<void>;
  /** Run once when the effect starts; call `pollNow` for extra triggers (e.g. window events). */
  onSetup?: (pollNow: () => void) => void | (() => void);
};

/** Immediate poll, interval repeats, and cleanup cancellation via `isActive`.
 * Callbacks retain their effect lifetime with useCallback at the call site. */
export function usePolling({ intervalMs, onPoll, onSetup }: UsePollingOptions): void {
  useEffect(() => {
    let active = true;
    const isActive = () => active;
    const pollNow = () => {
      void onPoll(isActive);
    };
    pollNow();
    const setupCleanup = onSetup?.(pollNow);
    const timer = setInterval(pollNow, intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
      setupCleanup?.();
    };
  }, [intervalMs, onPoll, onSetup]);
}
