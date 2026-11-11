import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  HardDrive,
  ImageIcon,
  ImageOff,
  Trash2,
} from "lucide-react";
import {
  type EligibleRunImage,
  type FactoryProject,
  type RunImageReference,
} from "@t3-factory/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SectionLabel } from "@/components/page";
import { cn } from "@/lib/utils";
import { RUN_IMAGE_DELETION_LIMIT } from "@t3-factory/domain-validation";
import { api } from "../api.ts";
import { MutationGate } from "../client-gate.tsx";
import { imageSize, revalidateRunImages, useRunImageSource } from "../run-images.ts";
import { useProjects } from "../use-projects.ts";

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const lifecycleLabel = { settled: "Settled", archived: "Archived" } as const;
const imageType = (image: EligibleRunImage) => image.mimeType.slice("image/".length).toUpperCase();
const runLabel = (run: RunImageReference) =>
  run.number === null ? run.title : `#${run.number} ${run.title}`;
const unique = (values: readonly string[]) => [...new Set(values)];

/** "#42 Add sign-in · Archived", or "2 Runs · #29, #33 · Settled" for a shared image. */
function runsSummary(runs: readonly RunImageReference[]) {
  const states = unique(runs.map((run) => lifecycleLabel[run.lifecycle])).join(", ");
  if (runs.length === 1) return `${runLabel(runs[0]!)} · ${states}`;
  const numbers = runs.map((run) => (run.number === null ? run.title : `#${run.number}`));
  return `${count(runs.length, "Run")} · ${numbers.join(", ")} · ${states}`;
}

const projectsOf = (image: EligibleRunImage) =>
  unique(image.runs.map((run) => run.project.title)).join(", ");

/**
 * Figma Settings/Section · Run images: stored images whose every Run is Settled or Archived, as
 * the server lists them for the chosen project, with an in-section preview.
 */
export function RunImageSettings() {
  const projects = useProjects() ?? [];
  const [projectId, setProjectId] = useState("");
  const [listed, setListed] = useState(0);
  const { images, error } = useEligibleImages(projectId, listed);
  const [previewed, setPreviewed] = useState<string | null>(null);
  const deletion = useImageDeletion(() => setListed((n) => n + 1));
  const project = projects.find((item) => item.id === projectId) ?? null;
  const index = images?.findIndex((image) => image.sha256 === previewed) ?? -1;
  // Moving to another view or filter abandons an open confirmation.
  const preview = (sha256: string | null) => {
    deletion.cancel();
    setPreviewed(sha256);
  };
  const confirmation = deletion.pending && (
    <DeleteConfirmation
      deletion={deletion.pending}
      project={project}
      busy={deletion.busy}
      onCancel={deletion.cancel}
      onConfirm={() => void deletion.confirm()}
    />
  );
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <h2 className="text-title font-semibold text-foreground">Run images</h2>
        <p className="text-sm text-muted-foreground">
          Images attached to Settled and Archived Runs, stored by the Factory server. Deleting an
          image removes only its file: the Run keeps its history and shows “Image unavailable” in
          its place.
        </p>
      </div>
      {[error, deletion.error].filter(Boolean).map((message) => (
        <Alert key={message} variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ))}
      {deletion.notice && (
        <Alert>
          <AlertDescription>{deletion.notice}</AlertDescription>
        </Alert>
      )}
      {images && index >= 0 ? (
        <RunImagePreview
          images={images}
          index={index}
          project={project}
          confirmation={confirmation}
          onIndexChange={(next) => preview(images[next]!.sha256)}
          onBack={() => preview(null)}
          onDelete={() => deletion.ask({ scope: "one", images: [images[index]!] })}
        />
      ) : (
        <RunImageList
          images={images}
          projects={projects}
          project={project}
          confirmation={confirmation}
          onProjectChange={(next) => {
            deletion.cancel();
            setProjectId(next);
          }}
          onOpen={preview}
          onDelete={(image) => deletion.ask({ scope: "one", images: [image] })}
          onDeleteAll={(listed) => deletion.ask({ scope: "all", images: listed })}
        />
      )}
    </div>
  );
}

/**
 * The server's eligible list for the project filter, read again whenever `listed` changes. It is
 * null until the current filter's list arrives, so nothing acts on another filter's images.
 */
function useEligibleImages(projectId: string, listed: number) {
  const [listing, setListing] = useState<{
    projectId: string;
    images: readonly EligibleRunImage[];
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    api.listEligibleRunImages(projectId).then(
      (images) => active && setListing({ projectId, images }),
      (cause: unknown) =>
        active &&
        setError(cause instanceof Error ? cause.message : "Run images could not be listed."),
    );
    return () => {
      active = false;
    };
  }, [projectId, listed]);
  return { images: listing?.projectId === projectId ? listing.images : null, error };
}

/** The pending confirmation, the deletion it confirms and its outcome; `deleted` relists. */
function useImageDeletion(deleted: () => void) {
  const [pending, setPending] = useState<Deletion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const ask = (next: Deletion) => {
    setError("");
    setNotice("");
    setPending(next);
  };
  const confirm = async () => {
    if (!pending) return;
    const digests = pending.images.map((image) => image.sha256);
    setBusy(true);
    try {
      const skipped = await deleteImages(digests);
      setNotice(skippedNotice(skipped.length));
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Run images could not be deleted.");
    } finally {
      setBusy(false);
      // A partial or lost answer cannot say which bytes are gone, so the server decides for all.
      revalidateRunImages(digests);
      deleted();
    }
  };
  return { pending, busy, error, notice, ask, cancel: () => setPending(null), confirm };
}

/** What a confirmation would delete: one image, or every image the current filter lists. */
type Deletion = { scope: "one" | "all"; images: readonly EligibleRunImage[] };

/** Deletes in batches the server accepts and returns the digests it kept. */
async function deleteImages(digests: readonly string[]) {
  const skipped: string[] = [];
  for (let start = 0; start < digests.length; start += RUN_IMAGE_DELETION_LIMIT) {
    const batch = digests.slice(start, start + RUN_IMAGE_DELETION_LIMIT);
    const result = await api.deleteRunImages({ sha256: batch });
    skipped.push(...result.skipped);
  }
  return skipped;
}

function skippedNotice(skipped: number) {
  if (skipped === 0) return "";
  return skipped === 1
    ? "1 image was kept because it is no longer eligible: an Active Run now uses it, or its file is already gone."
    : `${skipped} images were kept because they are no longer eligible: an Active Run now uses them, or their files are already gone.`;
}

/** "the Run keeps its", "both Runs keep their", "all 3 Runs keep their" history. */
function keepers(runs: number) {
  if (runs === 1) return "the Run keeps its history and shows";
  return `${runs === 2 ? "both" : `all ${runs}`} Runs keep their history and show`;
}

/** A filtered Delete all's note on other projects: kept, or also losing a shared image. */
function otherProjectsNote(images: readonly EligibleRunImage[], project: FactoryProject) {
  const shared = images.filter((image) =>
    image.runs.some((run) => run.project.id !== project.id),
  ).length;
  if (shared === 0) return " Images in other projects are kept.";
  return ` ${count(shared, "image")} ${shared === 1 ? "is" : "are"} also used by Runs in other projects; those Runs show “Image unavailable” too.`;
}

/** The confirmation's title, description and action for one image or every listed image. */
function deletionCopy({ scope, images }: Deletion, project: FactoryProject | null) {
  const size = imageSize(images.reduce((total, image) => total + image.sizeBytes, 0));
  const runs = new Map(images.flatMap((image) => image.runs).map((run) => [run.id, run]));
  if (scope === "one") {
    const image = images[0]!;
    return {
      title: `Delete ${image.name} (${size})?`,
      description: `Used by ${count(runs.size, "Run")} in ${projectsOf(image)}. The file is removed from the Factory server and cannot be restored; ${keepers(runs.size)} “Image unavailable” in its place.`,
      action: "Delete image",
    };
  }
  const onlyProject = project && [...runs.values()].every((run) => run.project.id === project.id);
  return {
    title: `Delete ${count(images.length, "image")} (${size}) from ${count(runs.size, "Run")}${onlyProject ? ` in ${project.title}` : ""}?`,
    description: `The files are removed from the Factory server and cannot be restored. Run history stays unchanged; ${images.length === 1 ? "this image shows" : "these images show"} as “Image unavailable”.${project ? otherProjectsNote(images, project) : ""}`,
    action: `Delete ${count(images.length, "image")}`,
  };
}

/** Figma R10c/R10e: what the deletion removes and keeps, with Cancel and the danger action. */
function DeleteConfirmation({
  deletion,
  project,
  busy,
  onCancel,
  onConfirm,
}: {
  deletion: Deletion;
  project: FactoryProject | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { title, description, action } = deletionCopy(deletion, project);
  return (
    <section
      role="alertdialog"
      aria-label={title}
      className="grid gap-2 rounded-lg border bg-card p-3"
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="mt-1 flex gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <MutationGate>
          <Button type="button" variant="danger" disabled={busy} onClick={onConfirm}>
            {busy ? "Deleting…" : action}
          </Button>
        </MutationGate>
      </div>
    </section>
  );
}

function RunImageList({
  images,
  projects,
  project,
  confirmation,
  onProjectChange,
  onOpen,
  onDelete,
  onDeleteAll,
}: {
  /** Null while the current filter's list is loading. */
  images: readonly EligibleRunImage[] | null;
  projects: readonly FactoryProject[];
  project: FactoryProject | null;
  confirmation: ReactNode;
  onProjectChange: (projectId: string) => void;
  onOpen: (sha256: string) => void;
  onDelete: (image: EligibleRunImage) => void;
  onDeleteAll: (images: readonly EligibleRunImage[]) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <RunImageSummary images={images} project={project} />
        <NativeSelect
          aria-label="Project"
          wrapperClassName="ml-auto w-50"
          value={project?.id ?? ""}
          onChange={(event) => onProjectChange(event.target.value)}
        >
          <NativeSelectOption value="">All projects</NativeSelectOption>
          {projects.map((item) => (
            <NativeSelectOption key={item.id} value={item.id}>
              {item.title}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {images && images.length > 0 && !confirmation && (
          <MutationGate>
            <Button type="button" variant="destructive" onClick={() => onDeleteAll(images)}>
              Delete all {images.length}
            </Button>
          </MutationGate>
        )}
      </div>
      {confirmation}
      {images === null ? null : images.length > 0 ? (
        <ul
          aria-label="Run images"
          className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-4"
        >
          {images.map((image) => (
            <li key={image.sha256}>
              <RunImageCard
                image={image}
                onOpen={() => onOpen(image.sha256)}
                onDelete={() => onDelete(image)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex min-h-55 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 text-center">
          <ImageIcon aria-hidden strokeWidth={1.5} className="mb-1 size-4 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            No stored images from Settled or Archived Runs
          </p>
          <p className="text-xs text-muted-foreground">
            Images appear here once every Run that uses them is Settled or Archived.
          </p>
        </div>
      )}
      <p className="text-2xs tracking-label text-muted-foreground">
        Images still used by an Active Run are not listed. Staged uploads no Run uses are removed
        automatically after 24 hours.
      </p>
    </>
  );
}

/** "12 images · 23.8 MiB from 9 Runs", narrowed to the chosen project. */
function RunImageSummary({
  images,
  project,
}: {
  images: readonly EligibleRunImage[] | null;
  project: FactoryProject | null;
}) {
  if (!images)
    return (
      <p className="mr-auto flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <HardDrive aria-hidden strokeWidth={1.5} className="size-4 shrink-0" />
        Listing images…
      </p>
    );
  const bytes = images.reduce((total, image) => total + image.sizeBytes, 0);
  const runs = new Set(
    images.flatMap((image) =>
      image.runs.filter((run) => !project || run.project.id === project.id).map((run) => run.id),
    ),
  );
  return (
    <p className="mr-auto flex min-w-0 items-center gap-2 text-sm">
      <HardDrive aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-muted-foreground" />
      {images.length === 0 ? (
        <span className="font-medium text-foreground">No images to delete</span>
      ) : (
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground">
            {count(images.length, "image")} · {imageSize(bytes)}
          </span>
          <span className="text-muted-foreground">
            {` from ${count(runs.size, "Run")}${project ? ` in ${project.title}` : ""}`}
          </span>
        </span>
      )}
    </p>
  );
}

/** The retained bytes, or an unavailable icon when they fail to load. */
function StoredImage({ image, preview }: { image: EligibleRunImage; preview?: boolean }) {
  const [unavailable, setUnavailable] = useState(false);
  const source = useRunImageSource();
  if (unavailable)
    return (
      <span className="flex size-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
        <ImageOff aria-hidden strokeWidth={1.5} className="size-4" />
        {preview && "Image unavailable"}
      </span>
    );
  return (
    <img
      src={source(image.sha256)}
      alt={preview ? image.name : ""}
      loading="lazy"
      className={preview ? "size-full object-contain" : "size-full object-cover"}
      onError={() => {
        revalidateRunImages([image.sha256]);
        setUnavailable(true);
      }}
    />
  );
}

/** Figma Settings/RunImageCard: thumbnail, name, size and type, its Runs and their projects. */
function RunImageCard({
  image,
  onOpen,
  onDelete,
}: {
  image: EligibleRunImage;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        aria-label={`Preview ${image.name}`}
        onClick={onOpen}
        className="group grid h-auto w-full justify-stretch gap-1.5 p-0 text-left font-normal whitespace-normal hover:bg-transparent"
      >
        <span className="block aspect-[162/104] overflow-hidden rounded-md border bg-card group-hover:border-border-strong">
          <StoredImage key={image.sha256} image={image} />
        </span>
        <span className="grid min-w-0 gap-px">
          <span className="truncate text-sm font-medium text-foreground">{image.name}</span>
          <span className="truncate text-2xs text-muted-foreground">
            {imageSize(image.sizeBytes)} · {imageType(image)}
          </span>
          <span className="truncate text-2xs text-muted-foreground">{runsSummary(image.runs)}</span>
          <span className="truncate text-2xs text-muted-foreground">{projectsOf(image)}</span>
        </span>
      </Button>
      <div className="absolute top-1 right-1">
        <MutationGate>
          <IconButton label={`Delete ${image.name}`} onClick={onDelete}>
            <Trash2 aria-hidden strokeWidth={1.5} />
          </IconButton>
        </MutationGate>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** One listed image at full size with every Run that uses it; ←/→ step within the list. */
function RunImagePreview({
  images,
  index,
  project,
  confirmation,
  onIndexChange,
  onBack,
  onDelete,
}: {
  images: readonly EligibleRunImage[];
  index: number;
  project: FactoryProject | null;
  confirmation: ReactNode;
  onIndexChange: (index: number) => void;
  onBack: () => void;
  onDelete: () => void;
}) {
  const image = images[index]!;
  // Wrapping keeps both buttons enabled, so focus never drops out at either end.
  const step = (offset: number) => onIndexChange((index + offset + images.length) % images.length);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!offset) return;
    event.preventDefault();
    step(offset);
  };
  return (
    <section aria-label={`Preview of ${image.name}`} className="grid gap-4" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2">
        <IconButton label="Back to Run images" onClick={onBack}>
          <ArrowLeft aria-hidden strokeWidth={1.5} />
        </IconButton>
        <div className="grid min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{image.name}</p>
          <p className="truncate text-2xs text-muted-foreground">
            {`Image ${index + 1} of ${images.length}${project ? ` in ${project.title}` : ""}`} ·{" "}
            {imageSize(image.sizeBytes)} · {imageType(image)}
          </p>
        </div>
        {images.length > 1 && (
          <>
            <IconButton label="Previous image" onClick={() => step(-1)}>
              <ChevronLeft aria-hidden strokeWidth={1.5} />
            </IconButton>
            <IconButton label="Next image" onClick={() => step(1)}>
              <ChevronRight aria-hidden strokeWidth={1.5} />
            </IconButton>
          </>
        )}
        {!confirmation && (
          <MutationGate>
            <Button type="button" variant="destructive" onClick={onDelete}>
              Delete image
            </Button>
          </MutationGate>
        )}
      </div>
      <div
        className={cn("overflow-hidden rounded-md border bg-card", confirmation ? "h-45" : "h-75")}
      >
        <StoredImage key={image.sha256} image={image} preview />
      </div>
      {confirmation}
      <div className="grid gap-2">
        <SectionLabel>Used by</SectionLabel>
        <ul aria-label="Used by" className="grid gap-1.5">
          {image.runs.map((run) => (
            <UsedByRow key={run.id} run={run} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function UsedByRow({ run }: { run: RunImageReference }) {
  return (
    <li className="flex items-center gap-3 rounded-md border bg-card px-3 py-2">
      <div className="grid min-w-0 flex-1">
        <span className="truncate text-sm text-foreground">{runLabel(run)}</span>
        <span className="truncate text-2xs text-muted-foreground">
          {lifecycleLabel[run.lifecycle]} · {run.project.title} · Image {run.ordinal}
        </span>
      </div>
      <Button asChild variant="ghost" size="xs">
        <Link
          to="/runs/$runId"
          params={{ runId: run.id }}
          search={{}}
          aria-label={`Open Run ${runLabel(run)}`}
        >
          Open Run
          <ExternalLink aria-hidden strokeWidth={1.5} />
        </Link>
      </Button>
    </li>
  );
}
