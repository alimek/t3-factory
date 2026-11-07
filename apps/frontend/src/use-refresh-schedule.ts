import { useEffect, useSyncExternalStore } from "react";

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const documentVisible = () => document.visibilityState !== "hidden";

/** Reads on load, focus and return to visibility; polls only while the document is visible. */
export function useRefreshSchedule(refresh: () => void | Promise<void>, watching: boolean) {
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh]);
  useEffect(() => {
    const read = () => void refresh();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [refresh]);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => void refresh(), watching ? 2500 : 30_000);
    return () => clearInterval(timer);
  }, [visible, watching, refresh]);
}
