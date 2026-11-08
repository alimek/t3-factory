import type { ConnectionLiveMessage, T3Connection } from "@t3-factory/contracts";
import {
  LiveOwner,
  type LiveDelivery,
  type LiveWatch,
  type SubscriptionEvents,
} from "../../src/live/owner.ts";

type FakeSession = {
  readonly connected: () => void;
  readonly disconnected: () => void;
  readonly subscriptions: SubscriptionEvents[];
  readonly watches: LiveWatch[];
  closed: boolean;
};

/** A live owner over scripted sockets and manual timers. */
export function liveHarness() {
  const sessions: FakeSession[] = [];
  const timers = new Set<{ run: () => void; ms: number }>();
  const classified: number[] = [];
  let delivery: LiveDelivery = "current";
  const owner = new LiveOwner({
    open(events) {
      const session: FakeSession = { ...events, subscriptions: [], watches: [], closed: false };
      sessions.push(session);
      return {
        subscribe(watch, subscription) {
          session.subscriptions.push(subscription);
          session.watches.push(watch);
          return () => undefined;
        },
        close() {
          session.closed = true;
        },
      };
    },
    setTimer(run, ms) {
      const timer = { run, ms };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    random: () => 1,
    classify: () => classified.push(sessions.length),
    publish(next) {
      delivery = next;
    },
  });
  return {
    owner,
    sessions,
    classified,
    delivery: () => delivery,
    openSockets: () => sessions.filter((session) => !session.closed).length,
    /** Runs every pending timer once, as if its delay elapsed. */
    elapse() {
      const due = [...timers];
      timers.clear();
      for (const timer of due) timer.run();
    },
  };
}

const connection = (state: T3Connection["state"]): T3Connection => ({
  endpoint: "http://127.0.0.1:0/mcp",
  state,
  explanation: "",
  checkedAt: null,
  authorizationContext: null,
  authorizationPending: false,
  contract: null,
});

export const envelope = <M>(messages: readonly M[], current = true) => ({ current, messages });

export const snapshot = (state: T3Connection["state"], current = true) =>
  envelope<ConnectionLiveMessage>([{ _tag: "snapshot", connection: connection(state) }], current);

export const changed = (state: T3Connection["state"]) =>
  envelope<ConnectionLiveMessage>([{ _tag: "changed", connection: connection(state) }]);

export const checked = (checkedAt: string) =>
  envelope<ConnectionLiveMessage>([{ _tag: "checked", checkedAt }]);
