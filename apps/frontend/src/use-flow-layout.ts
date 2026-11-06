import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FlowGraph } from "@t3-factory/contracts";
import ELK from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import {
  applyLayoutPositions,
  buildElkGraph,
  parseElkLayout,
  type FlowLayoutResult,
} from "./flow-layout-elk.ts";
import { layoutDimensions, type FlowLayoutProfile } from "./flow-layout-profile.ts";

type PendingRequest = {
  readonly generation: number;
  readonly resolve: (result: FlowLayoutResult | null) => void;
};

function useFlowLayoutWorker(profile: FlowLayoutProfile) {
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRequest = useRef<PendingRequest | null>(null);
  const profileRef = useRef(profile);
  useLayoutEffect(() => {
    profileRef.current = profile;
  }, [profile]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settle = useCallback((result: FlowLayoutResult | null) => {
    if (timeout.current !== null) clearTimeout(timeout.current);
    timeout.current = null;
    const active = pendingRequest.current;
    pendingRequest.current = null;
    active?.resolve(result);
  }, []);
  const cancel = useCallback(() => {
    settle(null);
    worker.current?.terminate();
    worker.current = null;
    setPending(false);
  }, [settle]);

  useEffect(
    () => () => {
      settle(null);
      worker.current?.terminate();
      worker.current = null;
    },
    [settle],
  );

  const arrange = useCallback(
    (graph: FlowGraph, feedback: "visible" | "silent" = "visible") => {
      cancel();
      if (feedback === "visible") setError(null);
      setPending(feedback === "visible");
      return new Promise<FlowLayoutResult | null>((resolve) => {
        const id = ++generation.current;
        pendingRequest.current = { generation: id, resolve };
        const fail = (message: string) => {
          if (pendingRequest.current?.generation !== id) return;
          settle(null);
          setPending(false);
          if (feedback === "visible") setError(message);
          worker.current?.terminate();
          worker.current = null;
        };
        timeout.current = setTimeout(
          () => fail("Auto-arrange timed out. Try a smaller Flow."),
          15_000,
        );
        try {
          const instance = new ElkWorker();
          worker.current = instance;
          const elk = new ELK({ workerFactory: () => instance });
          instance.onerror = (event) => fail(event.message || "Auto-arrange failed. Try again.");
          instance.onmessageerror = () => fail("Could not read the arranged Flow. Try again.");
          void elk
            .layout(buildElkGraph(graph, layoutDimensions(profileRef.current)))
            .then((laidOut) => {
              if (pendingRequest.current?.generation !== id) return;
              const result = parseElkLayout(graph, laidOut);
              settle(result);
              setPending(false);
              instance.terminate();
              worker.current = null;
            })
            .catch((cause: unknown) =>
              fail(cause instanceof Error ? cause.message : "Auto-arrange failed."),
            );
        } catch (cause) {
          fail(cause instanceof Error ? cause.message : "Auto-arrange failed.");
        }
      });
    },
    [cancel, settle],
  );
  const dismissError = useCallback(() => setError(null), []);
  return { pending, error, arrange, cancel, dismissError };
}

type AuthoringPolicy = {
  readonly busy: boolean;
  readonly savedGraph: FlowGraph | undefined;
  readonly change: (graph: FlowGraph) => void;
  readonly onAccepted: (graph: FlowGraph) => void;
};

type FlowLayoutSessionOptions = {
  readonly scope: string;
  readonly graph: FlowGraph;
  readonly profile: FlowLayoutProfile;
  /** Omit for local, read-only Run presentation. */
  readonly authoring?: AuthoringPolicy;
};

type AcceptedLayout = {
  readonly scope: string;
  readonly basisKey: string;
  readonly graphKey: string;
  readonly graph: FlowGraph;
  readonly routes: FlowLayoutResult["routes"];
};

type LayoutBasis = { readonly options: FlowLayoutSessionOptions; readonly basisKey: string };

function sameBasis(start: LayoutBasis, current: LayoutBasis) {
  return (
    start.options.scope === current.options.scope &&
    start.basisKey === current.basisKey &&
    (!current.options.authoring || start.options.graph === current.options.graph)
  );
}

function acceptedForGraph(accepted: AcceptedLayout | null, current: LayoutBasis) {
  if (accepted?.scope !== current.options.scope) return null;
  const matches = current.options.authoring
    ? accepted.graphKey === current.basisKey
    : accepted.basisKey === current.basisKey;
  return matches ? accepted : null;
}

/** Owns request validity and commits positions/routes together, before notifying the caller. */
export function useFlowLayoutSession(options: FlowLayoutSessionOptions) {
  const { scope, graph, profile, authoring } = options;
  const basisKey = useMemo(() => JSON.stringify(graph), [graph]);
  // Authoring edits invalidate even equal-content graph replacements. Run polls do not.
  const basis = authoring ? graph : basisKey;
  const worker = useFlowLayoutWorker(profile);
  const { arrange: compute, cancel: cancelWorker } = worker;
  const generation = useRef(0);
  const live = useRef({ options, basisKey });
  useLayoutEffect(() => {
    live.current = { options, basisKey };
  });
  const [accepted, setAccepted] = useState<AcceptedLayout | null>(null);
  const cancel = useCallback(() => {
    generation.current += 1;
    cancelWorker();
  }, [cancelWorker]);
  useLayoutEffect(() => {
    cancel();
    setAccepted((previous) => acceptedForGraph(previous, live.current));
    return cancel;
  }, [scope, basis, cancel]);

  const arrange = useCallback(
    async (restoreOnly = false) => {
      const start = live.current;
      if (!restoreOnly && start.options.authoring?.busy) return;
      const request = ++generation.current;
      const result = await compute(start.options.graph, restoreOnly ? "silent" : "visible");
      const current = live.current;
      if (
        !result ||
        request !== generation.current ||
        !sameBasis(start, current) ||
        (!restoreOnly && current.options.authoring?.busy)
      )
        return;
      const next = applyLayoutPositions(start.options.graph, result);
      // Saved route reconstruction may never move nodes or mutate the draft.
      if (restoreOnly && JSON.stringify(next) !== current.basisKey) return;
      const acceptedGraph = restoreOnly ? current.options.graph : next;
      setAccepted({
        scope: current.options.scope,
        basisKey: current.basisKey,
        graphKey: JSON.stringify(acceptedGraph),
        graph: acceptedGraph,
        routes: result.routes,
      });
      if (!restoreOnly && current.options.authoring) {
        current.options.authoring.change(acceptedGraph);
        current.options.authoring.onAccepted(acceptedGraph);
      }
    },
    [compute],
  );

  const savedGraph = authoring?.savedGraph;
  useEffect(() => {
    if (!savedGraph || savedGraph !== graph) return;
    void arrange(true);
    return cancel;
  }, [savedGraph, graph, arrange, cancel]);

  // Validate during render: navigation must never paint old geometry, even before effects.
  const valid = acceptedForGraph(accepted, { options, basisKey });
  const autoArrange = useCallback(() => arrange(), [arrange]);
  return {
    graph: valid?.graph ?? graph,
    wireRoutes: valid?.routes ?? null,
    accepted: valid?.graph ?? null,
    pending: worker.pending,
    error: worker.error,
    dismissError: worker.dismissError,
    cancel,
    autoArrange,
  };
}
