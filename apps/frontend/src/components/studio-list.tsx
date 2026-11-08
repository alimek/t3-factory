import { MutationGate } from "@/client-gate";
import { Plus, Search } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export const studioRowClass =
  "flex w-full items-center gap-3 rounded-lg border bg-muted px-4 py-3 text-left text-foreground no-underline outline-none transition-colors hover:border-border-hover hover:bg-accent hover:no-underline focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function StudioListHeader({
  title,
  description,
  query,
  onQueryChange,
  onCreate,
  createLabel,
}: {
  title: string;
  description: string;
  query: string;
  onQueryChange: (query: string) => void;
  onCreate: () => void;
  createLabel: string;
}) {
  return (
    <header className="flex flex-wrap items-center gap-4">
      <div className="grid min-w-60 flex-1 gap-1.5">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="relative w-60">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-2 left-2.5 size-4 text-subtle-foreground"
          strokeWidth={1.5}
        />
        <Input
          aria-label={`Search ${title}`}
          placeholder={`Search ${title}`}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="bg-muted pl-9"
        />
      </div>
      <MutationGate>
        <Button onClick={onCreate}>
          <Plus aria-hidden strokeWidth={1.5} />
          {createLabel}
        </Button>
      </MutationGate>
    </header>
  );
}

export function editedLabel(updatedAt: string) {
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(updatedAt).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days <= 0) return "Edited today";
  if (days === 1) return "Edited yesterday";
  return `Edited ${new Date(updatedAt).toLocaleDateString()}`;
}
