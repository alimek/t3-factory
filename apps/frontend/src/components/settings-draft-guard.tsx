import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { settingsTabAt, type SettingsSelection } from "../settings-navigation.ts";

type Decision = { status: "blocked"; reset: () => void; proceed: () => void } | { status: "idle" };

/**
 * Asks before leaving `tab`, closing Settings or unloading the page while `drafts`, the titles of
 * that page's sections with unsaved edits, is not empty. Each section keeps its own Save/Discard.
 */
export function useSettingsDraftGuard(tab: SettingsSelection["tab"], drafts: readonly string[]) {
  const router = useRouter();
  const pending = useRef<((block: boolean) => void) | undefined>(undefined);
  const [decision, setDecision] = useState<Decision>({ status: "idle" });
  const draftsRef = useRef(drafts);
  useLayoutEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);
  const dirty = drafts.length > 0;
  useEffect(() => {
    if (!dirty) return;
    const unblock = router.history.block({
      enableBeforeUnload: true,
      blockerFn: async ({ nextLocation }) => {
        if (!draftsRef.current.length || settingsTabAt(router.parseLocation(nextLocation)) === tab)
          return false;
        if (pending.current) return true;
        const blocked = await new Promise<boolean>((resolve) => {
          pending.current = resolve;
          setDecision({
            status: "blocked",
            reset: () => resolve(true),
            proceed: () => resolve(false),
          });
        });
        pending.current = undefined;
        setDecision({ status: "idle" });
        return blocked;
      },
    });
    return () => {
      pending.current?.(true);
      pending.current = undefined;
      unblock();
    };
  }, [dirty, router, tab]);
  return decision;
}

/** Keep editing or discard every listed section's unsaved edits and continue. */
export function SettingsDraftDialog({
  decision,
  drafts,
}: {
  decision: ReturnType<typeof useSettingsDraftGuard>;
  drafts: readonly string[];
}) {
  if (decision.status !== "blocked") return null;
  const names = drafts.join(" and ");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) decision.reset();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          decision.reset();
        }}
      >
        <DialogTitle>Discard unsaved {names} changes?</DialogTitle>
        <DialogDescription>
          Keep editing to save them, or discard them to continue. Saved settings stay as they are.
        </DialogDescription>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={decision.reset}>
            Keep editing
          </Button>
          <Button variant="destructive" onClick={decision.proceed}>
            Discard changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
