import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { FactoryProject, ProjectCatalog } from "@t3-factory/contracts";
import { ChevronsUpDownIcon, FolderPlusIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PickerMenuContent, PickerMenuSearch } from "./picker-menu-search.tsx";
import { Label } from "@/components/ui/label";
import { api } from "../api.ts";
import { usePolling } from "../use-polling.ts";
import { fieldLabelClass, selectFieldClass } from "./page.tsx";
import { ProjectIcon } from "./project-icon.tsx";

const availabilityLabels: Record<FactoryProject["availability"], string> = {
  available: "Available",
  "directory-unavailable": "Repository unavailable",
  "project-unavailable": "Project unavailable",
  "connection-unavailable": "T3 connection unavailable",
  "different-environment": "Different environment",
};

function ProjectOption({ project, busy }: { project: FactoryProject; busy: boolean }) {
  const available = project.availability === "available";
  const availability = availabilityLabels[project.availability];
  return (
    <DropdownMenuRadioItem
      value={project.id}
      data-project-id={project.id}
      indicatorPosition="right"
      disabled={busy}
      aria-label={`${project.title} · ${project.workspaceRoot} · ${availability}`}
      className="my-0.5 items-start rounded-md py-2 data-[state=checked]:bg-brand-soft data-[state=checked]:ring-1 data-[state=checked]:ring-brand-soft-border data-[state=checked]:ring-inset data-[state=checked]:focus:bg-brand-soft data-[state=checked]:focus-visible:ring-2 data-[state=checked]:focus-visible:ring-ring"
    >
      <span className="mt-px">
        <ProjectIcon
          inline
          icon={project.projectIcon}
          faviconUrl={project.availability === "available" ? project.faviconUrl : null}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium" title={project.title}>
          {project.title}
        </span>
        <span
          className="mt-0.5 block truncate text-left text-2xs tracking-label text-subtle-foreground"
          title={project.workspaceRoot}
          dir="rtl"
        >
          <bdi dir="ltr">{project.workspaceRoot}</bdi>
        </span>
        {!available && (
          <span className="mt-1 block text-xs text-attention">
            {availability} · New Runs blocked
          </span>
        )}
      </span>
    </DropdownMenuRadioItem>
  );
}

function ProjectChoices({
  catalog,
  busy,
  search,
  listRef,
  onSelect,
}: {
  catalog: ProjectCatalog | null;
  busy: boolean;
  search: string;
  listRef: RefObject<HTMLDivElement | null>;
  onSelect: (value: string) => void;
}) {
  const query = search.trim().toLocaleLowerCase();
  const projects = (catalog?.projects ?? []).filter((project) =>
    `${project.title} ${project.workspaceRoot}`.toLocaleLowerCase().includes(query),
  );
  const positioned = useRef(false);
  useLayoutEffect(() => {
    if (positioned.current || !catalog) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-state="checked"]')
      ?.scrollIntoView({ block: "nearest" });
    positioned.current = true;
  }, [catalog, listRef]);
  return (
    <div
      ref={listRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
      role="group"
      aria-label="Projects"
    >
      <DropdownMenuRadioGroup value={catalog?.selectedProjectId ?? ""} onValueChange={onSelect}>
        <DropdownMenuRadioItem
          value=""
          disabled={busy}
          aria-label="No project selected"
          indicatorPosition="right"
          className="my-0.5 rounded-md py-2.5 data-[state=checked]:bg-brand-soft data-[state=checked]:ring-1 data-[state=checked]:ring-brand-soft-border data-[state=checked]:ring-inset data-[state=checked]:focus:bg-brand-soft data-[state=checked]:focus-visible:ring-2 data-[state=checked]:focus-visible:ring-ring"
        >
          <span className="text-sm text-muted-foreground">No project selected</span>
        </DropdownMenuRadioItem>
        {projects.map((project) => (
          <ProjectOption key={project.id} project={project} busy={busy} />
        ))}
      </DropdownMenuRadioGroup>
      {projects.length === 0 && (
        <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
          {catalog === null
            ? "Loading projects…"
            : query
              ? "No matching projects."
              : "No projects found. Add an existing repository to get started."}
        </p>
      )}
    </div>
  );
}

function ProjectTriggerSummary({ selected }: { selected: FactoryProject | undefined }) {
  const available = selected?.availability === "available";
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
      <ProjectIcon
        inline
        icon={selected?.projectIcon}
        faviconUrl={available ? (selected?.faviconUrl ?? null) : null}
      />
      {selected ? (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 truncate font-medium" title={selected.title}>
            {selected.title}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-2xs tracking-label text-subtle-foreground"
            title={selected.workspaceRoot}
            dir="rtl"
          >
            <bdi dir="ltr">
              {available ? selected.workspaceRoot : availabilityLabels[selected.availability]}
            </bdi>
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">No project selected</span>
      )}
    </span>
  );
}

export function useProjectCatalog() {
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  usePolling({
    intervalMs: 5_000,
    onPoll: useCallback(
      (isActive) =>
        api
          .listProjects()
          .then((value) => {
            if (isActive()) {
              setCatalog(value);
              setLoadError("");
            }
          })
          .catch(() => {
            if (isActive()) setLoadError("Could not load projects.");
          }),
      [],
    ),
  });

  async function act(action: () => Promise<ProjectCatalog>) {
    setBusy(true);
    setError("");
    try {
      setCatalog(await action());
      window.dispatchEvent(new Event("factory-project-changed"));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Project operation failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { catalog, error, loadError, busy, act, clearError: () => setError("") };
}

function AddRepositoryDialog({
  open,
  onOpenChange,
  busy,
  error,
  onAdd,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  error: string;
  onAdd: (path: string) => Promise<boolean>;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const [path, setPath] = useState("");
  const pathRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
          <DialogDescription>
            Use an existing repository on the local T3 host. T3 owns its project and path.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            void onAdd(path).then((success) => {
              if (success) setPath("");
              else pathRef.current?.focus();
            });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="repository-path">Existing local repository path</Label>
            <Input
              ref={pathRef}
              id="repository-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/absolute/path/to/repository"
              required
              readOnly={busy}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={busy || !path.trim()}>
            Add existing repository
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A selected-but-unavailable project or an empty catalog marks the field invalid (Figma L02/L04). */
function selectionBlocked(selected: FactoryProject | undefined, catalog: ProjectCatalog | null) {
  if (selected) return selected.availability !== "available";
  return catalog?.projects.length === 0;
}

export function ProjectPicker({
  state,
  selectedId,
  onSelect,
  disabled = false,
}: {
  state: ReturnType<typeof useProjectCatalog>;
  selectedId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const { catalog, error, loadError, act, clearError } = state;
  const busy = state.busy || disabled;
  const choices = catalog && {
    ...catalog,
    selectedProjectId: selectedId,
    projects: catalog.projects.filter((p) => p.availability === "available"),
  };
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = catalog?.projects.find((p) => p.id === selectedId);
  const invalid = selectionBlocked(selected, catalog);
  return (
    <div className="min-w-0">
      <div className="grid min-w-0 grid-cols-1 gap-1.5">
        <Label className={fieldLabelClass}>Project</Label>
        <DropdownMenu
          open={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open && !busy);
            if (open) setSearch("");
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="outline"
              aria-disabled={busy}
              aria-busy={busy}
              aria-label={`Select project: ${selected?.title ?? "No project selected"}`}
              aria-invalid={invalid || undefined}
              className={selectFieldClass}
            >
              <ProjectTriggerSummary selected={selected} />
              <ChevronsUpDownIcon
                className="size-4 shrink-0 text-muted-foreground"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </Button>
          </DropdownMenuTrigger>
          <PickerMenuContent
            className="flex max-h-[min(30rem,var(--radix-dropdown-menu-content-available-height))] w-96 max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0"
            searchRef={searchRef}
            listRef={listRef}
            searchEnabled
          >
            <PickerMenuSearch
              ariaLabel="Search projects"
              placeholder="Search by name or repository path…"
              value={search}
              onChange={setSearch}
              inputRef={searchRef}
              listRef={listRef}
              firstChoiceSelector="[data-project-id]"
            />
            <ProjectChoices
              catalog={choices}
              busy={busy}
              search={search}
              listRef={listRef}
              onSelect={(value) => {
                if (busy) return;
                setMenuOpen(false);
                const id = value || null;
                void act(() => api.selectProject({ id })).then((success) => {
                  if (!success) return;
                  onSelect(value);
                });
              }}
            />
            <DropdownMenuSeparator className="m-0 shrink-0" />
            <div className="shrink-0 p-1">
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => {
                  void act(api.recheckProjects);
                }}
              >
                <RefreshCwIcon aria-hidden />
                Recheck projects
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => {
                  clearError();
                  setAddDialogOpen(true);
                }}
              >
                <FolderPlusIcon aria-hidden />
                Add repository
              </DropdownMenuItem>
            </div>
          </PickerMenuContent>
        </DropdownMenu>
      </div>
      <ProjectAvailability selected={selected} catalog={catalog} />
      <AddRepositoryDialog
        open={addDialogOpen}
        busy={busy}
        error={error}
        triggerRef={triggerRef}
        onOpenChange={(open) => {
          clearError();
          setAddDialogOpen(open);
        }}
        onAdd={(path) =>
          act(async () => {
            const project = await api.addRepository({ path });
            const result = await api.selectProject({ id: project.id });
            setAddDialogOpen(false);
            onSelect(project.id);
            return result;
          })
        }
      />
      {(loadError || (error && !addDialogOpen)) && (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{loadError || error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function ProjectAvailability({
  selected,
  catalog,
}: {
  selected: FactoryProject | undefined;
  catalog: ProjectCatalog | null;
}) {
  return (
    <>
      {" "}
      {selected && selected.availability !== "available" && (
        <p className="mt-1.5 text-2xs text-destructive" role="status">
          {availabilityLabels[selected.availability]} · New Runs blocked. Choose another project.
        </p>
      )}
      {catalog && catalog.projects.length === 0 && (
        <p className="mt-1.5 text-2xs text-destructive" role="status">
          T3 doesn’t report any projects yet.
        </p>
      )}
      {catalog?.problem && (
        <p className="mt-1.5 text-2xs text-muted-foreground" role="status">
          {catalog.problem}
        </p>
      )}
    </>
  );
}
