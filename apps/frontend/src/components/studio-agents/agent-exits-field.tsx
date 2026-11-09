import { Plus, X } from "lucide-react";
import type { BlockExit } from "@t3-factory/contracts";
import { fieldLabelClass } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
      <div className="min-w-0 overflow-x-auto">
        <table
          aria-label="Agent exits"
          className="w-full min-w-140 table-fixed border-separate border-spacing-0 text-xs"
        >
          <thead>
            <tr className="text-left text-2xs text-muted-foreground">
              <th scope="col" className="w-40 pr-2 pb-1 font-medium">
                Name
              </th>
              <th scope="col" className="pr-2 pb-1 font-medium">
                Description
              </th>
              <th scope="col" className="w-30 pb-1 text-center font-medium">
                Message required
              </th>
              <th scope="col" className="w-8">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {exits.map((exit, index) => (
              <tr key={exit.id}>
                <td className="py-1 pr-2">
                  <Input
                    aria-label={`Exit ${index + 1} name`}
                    maxLength={200}
                    value={exit.name}
                    onChange={(event) => update(exit.id, { name: event.target.value })}
                    className="h-8 bg-muted font-mono text-xs"
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    aria-label={`Exit ${index + 1} description`}
                    maxLength={4000}
                    placeholder="Description (optional)"
                    value={exit.description}
                    onChange={(event) => update(exit.id, { description: event.target.value })}
                    className="h-8 bg-muted text-xs"
                  />
                </td>
                <td className="py-1 text-center">
                  <Checkbox
                    aria-label={`Exit ${index + 1} message required`}
                    disabled={disabled}
                    checked={exit.messageRequired}
                    onCheckedChange={(checked) =>
                      update(exit.id, { messageRequired: checked === true })
                    }
                  />
                </td>
                <td className="py-1 text-right">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove exit ${index + 1}`}
                        onClick={() => onChange(exits.filter((item) => item.id !== exit.id))}
                      >
                        <X aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Remove exit {exit.name || index + 1}</TooltipContent>
                  </Tooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
