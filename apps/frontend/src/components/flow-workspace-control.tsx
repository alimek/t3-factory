import { useId } from "react";
import type { FlowWorkspace } from "@t3-factory/contracts";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function workspaceSummary(workspace: FlowWorkspace) {
  if (workspace.mode === "checkout") return "Project checkout";
  if (workspace.base.kind === "default") return "New worktree · default branch";
  return `New worktree · ${workspace.base.ref.trim() || "custom ref"}`;
}

/** The Flow's workspace setting, edited as part of the unsaved Flow draft. */
export function FlowWorkspaceControl({
  workspace,
  disabled,
  onChange,
}: {
  workspace: FlowWorkspace;
  disabled: boolean;
  onChange: (workspace: FlowWorkspace) => void;
}) {
  const modeId = useId();
  const baseId = useId();
  const refId = useId();
  const summary = workspaceSummary(workspace);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" disabled={disabled} aria-label={`Workspace: ${summary}`}>
          <GitBranch aria-hidden />
          <span className="max-w-56 truncate">{summary}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-80 gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={modeId}>Workspace</Label>
          <NativeSelect
            id={modeId}
            value={workspace.mode}
            onChange={(e) =>
              onChange(
                e.target.value === "checkout"
                  ? { mode: "checkout" }
                  : { mode: "worktree", base: { kind: "default" } },
              )
            }
          >
            <NativeSelectOption value="worktree">New worktree</NativeSelectOption>
            <NativeSelectOption value="checkout">Project checkout</NativeSelectOption>
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            {workspace.mode === "worktree"
              ? "Each Run gets its own worktree, shared by all of its workers."
              : "Workers edit the selected project's checkout, shared with other Runs."}
          </p>
        </div>
        {workspace.mode === "worktree" && (
          <div className="grid gap-1.5">
            <Label htmlFor={baseId}>Base</Label>
            <NativeSelect
              id={baseId}
              value={workspace.base.kind}
              onChange={(e) =>
                onChange({
                  mode: "worktree",
                  base: e.target.value === "ref" ? { kind: "ref", ref: "" } : { kind: "default" },
                })
              }
            >
              <NativeSelectOption value="default">Default branch</NativeSelectOption>
              <NativeSelectOption value="ref">Custom ref</NativeSelectOption>
            </NativeSelect>
            {workspace.base.kind === "ref" && (
              <>
                <Label htmlFor={refId} className="sr-only">
                  Custom ref
                </Label>
                <Input
                  id={refId}
                  placeholder="develop"
                  value={workspace.base.ref}
                  onChange={(e) =>
                    onChange({ mode: "worktree", base: { kind: "ref", ref: e.target.value } })
                  }
                />
              </>
            )}
            <p className="text-xs text-muted-foreground">
              {workspace.base.kind === "default"
                ? "The project repository's origin default branch, such as origin/main."
                : "A branch, tag or commit in the project repository."}{" "}
              Start checks it in the selected project and launches nothing when it is missing.
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
