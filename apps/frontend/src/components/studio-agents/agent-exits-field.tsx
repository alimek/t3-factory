import { Plus, X } from "lucide-react";
import type { BlockExit } from "@t3-factory/contracts";
import { fieldLabelClass } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { randomId } from "@/lib/ids";

/** A new Agent starts with one exit, `done`, which needs no message. */
export function newAgentExits(): BlockExit[] {
  return [{ id: randomId(), name: "done", description: "", messageRequired: false }];
}

/**
 * The Agent's exits: every Flow block of this Agent offers them. IDs stay stable across
 * renames, so wires in every Flow stay connected.
 */
export function AgentExitsField({
  exits,
  disabled,
  onChange,
}: {
  exits: readonly BlockExit[];
  disabled: boolean;
  onChange: (exits: BlockExit[]) => void;
}) {
  const update = (id: string, patch: Partial<BlockExit>) =>
    onChange(exits.map((exit) => (exit.id === id ? { ...exit, ...patch } : exit)));
  return (
    <fieldset className="grid min-w-0 gap-1.5" disabled={disabled}>
      <legend className={fieldLabelClass}>Exits</legend>
      {exits.length > 0 && (
        <ul className="grid gap-1.5">
          {exits.map((exit, index) => (
            <li key={exit.id} className="flex min-w-0 flex-wrap items-center gap-2">
              <Input
                aria-label={`Exit ${index + 1} name`}
                maxLength={200}
                value={exit.name}
                onChange={(event) => update(exit.id, { name: event.target.value })}
                className="w-40 bg-muted font-mono text-xs"
              />
              <Input
                aria-label={`Exit ${index + 1} description`}
                maxLength={4000}
                placeholder="Description (optional)"
                value={exit.description}
                onChange={(event) => update(exit.id, { description: event.target.value })}
                className="min-w-40 flex-1 bg-muted text-xs"
              />
              <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                <Checkbox
                  checked={exit.messageRequired}
                  onCheckedChange={(checked) =>
                    update(exit.id, { messageRequired: checked === true })
                  }
                />
                Message required
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove exit ${index + 1}`}
                onClick={() => onChange(exits.filter((item) => item.id !== exit.id))}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            onChange([
              ...exits,
              { id: randomId(), name: "", description: "", messageRequired: false },
            ])
          }
        >
          <Plus aria-hidden /> Add exit
        </Button>
        <span className="text-2xs tracking-label text-subtle-foreground">
          Flows using this Agent offer these exits on their next Run.
        </span>
      </div>
    </fieldset>
  );
}
