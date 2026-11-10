import { Fragment, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Image as ImageIcon, ImageOff } from "lucide-react";
import type { RunDetail, RunImage } from "@t3-factory/contracts";
import { operationPath, runOperations } from "@t3-factory/contracts";
import { ImagePreviewDialog, previewImageClass } from "./prompt-images.tsx";
import { Button } from "./ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

const FLOW_INPUT_THUMBNAILS = 3;

/** Matches the worker's frozen `[Image N: name]` text: the ordinal is the manifest position + 1. */
function imageLabel(image: RunImage, index: number) {
  return `Image ${index + 1}: ${image.name}`;
}

/** The prompt as plain text with `Image N: name` references, for accessible names and titles. */
export function runPromptText(run: RunDetail) {
  const indexOf = new Map(run.images.map((image, index) => [image.imageId, index]));
  return run.segments
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      const index = indexOf.get(segment.imageId)!;
      return imageLabel(run.images[index]!, index);
    })
    .join("")
    .trim();
}

/**
 * Gallery position and the images whose bytes failed to load for one view of the prompt.
 * A failed read only swaps in a placeholder; it is never retried and changes nothing else.
 */
function useRunImages(run: RunDetail) {
  const [galleryIndex, setGalleryIndex] = useState<number>();
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  const markUnavailable = (sha256: string) =>
    setUnavailable((current) => (current.has(sha256) ? current : new Set(current).add(sha256)));
  const gallery =
    galleryIndex === undefined ? null : (
      <RunImageGallery
        images={run.images}
        index={galleryIndex}
        unavailable={unavailable}
        onUnavailable={markUnavailable}
        onIndexChange={setGalleryIndex}
        onClose={() => setGalleryIndex(undefined)}
      />
    );
  return { openAt: setGalleryIndex, unavailable, markUnavailable, gallery };
}

const referenceClass = "mx-0.5 h-4.5 max-w-full px-1 align-bottom font-sans text-link";

/**
 * The prompt with each image reference as an `Image N: name` chip. Without `onOpen` the chips are
 * labels only: a clamped prompt must not hold focusable controls that scroll its hidden lines in.
 */
function PromptSegments({ run, onOpen }: { run: RunDetail; onOpen?: (index: number) => void }) {
  const indexOf = new Map(run.images.map((image, index) => [image.imageId, index]));
  return run.segments.map((segment, position) => {
    if (segment.type === "text") return <Fragment key={position}>{segment.text}</Fragment>;
    const index = indexOf.get(segment.imageId)!;
    const content = (
      <>
        <ImageIcon aria-hidden />
        <span className="truncate">{imageLabel(run.images[index]!, index)}</span>
      </>
    );
    if (!onOpen)
      return (
        <span
          key={position}
          className={`${referenceClass} inline-flex items-center gap-1 rounded-sm border bg-muted text-2xs font-medium [&_svg]:size-3 [&_svg]:shrink-0`}
        >
          {content}
        </span>
      );
    return (
      <Button
        key={position}
        type="button"
        variant="secondary"
        size="xs"
        onClick={() => onOpen(index)}
        className={`${referenceClass} has-[>svg]:px-1`}
      >
        {content}
      </Button>
    );
  });
}

/** The image's retained bytes, or an unavailable icon once they fail to load. */
function ImageSlot({
  image,
  unavailable,
  onUnavailable,
}: {
  image: RunImage;
  unavailable: boolean;
  onUnavailable: (sha256: string) => void;
}) {
  if (unavailable) return <ImageOff aria-hidden className="text-muted-foreground" />;
  return (
    <img
      src={operationPath(runOperations.getRunImage, image.sha256)}
      alt=""
      loading="lazy"
      className="size-full object-cover"
      onError={() => onUnavailable(image.sha256)}
    />
  );
}

function RunImageThumbnail({
  image,
  index,
  unavailable,
  onUnavailable,
  onOpen,
}: {
  image: RunImage;
  index: number;
  unavailable: boolean;
  onUnavailable: (sha256: string) => void;
  onOpen: () => void;
}) {
  const label = imageLabel(image, index);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={`Open ${label}`}
          onClick={onOpen}
          className="size-9 overflow-hidden rounded-md p-0"
        >
          <ImageSlot image={image} unavailable={unavailable} onUnavailable={onUnavailable} />
          {unavailable && <span className="sr-only">Image unavailable</span>}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{unavailable ? `${label} · Image unavailable` : label}</TooltipContent>
    </Tooltip>
  );
}

/** Every image of the Run in manifest order, one full-size preview at a time. */
function RunImageGallery({
  images,
  index,
  unavailable,
  onUnavailable,
  onIndexChange,
  onClose,
}: {
  images: readonly RunImage[];
  index: number;
  unavailable: ReadonlySet<string>;
  onUnavailable: (sha256: string) => void;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const image = images[index]!;
  const label = imageLabel(image, index);
  // Wrapping keeps both buttons enabled, so focus never drops out of the dialog at either end.
  const step = (offset: number) => onIndexChange((index + offset + images.length) % images.length);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!offset) return;
    event.preventDefault();
    step(offset);
  };
  return (
    <ImagePreviewDialog
      title={
        <>
          <span>{`Image ${index + 1} of ${images.length}`}</span>
          <span className="ml-2 font-normal text-muted-foreground">{` ${image.name}`}</span>
        </>
      }
      onClose={onClose}
      onKeyDown={onKeyDown}
    >
      {unavailable.has(image.sha256) ? (
        <div className="flex min-h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted px-4 text-center">
          <ImageOff aria-hidden className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">Image unavailable</p>
          <p className="max-w-full truncate text-xs text-muted-foreground">{label}</p>
        </div>
      ) : (
        <img
          key={image.sha256}
          src={operationPath(runOperations.getRunImage, image.sha256)}
          alt={label}
          className={previewImageClass}
          onError={() => onUnavailable(image.sha256)}
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={images.length < 2}
          onClick={() => step(-1)}
        >
          <ChevronLeft aria-hidden />
          Previous image
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={images.length < 2}
          onClick={() => step(1)}
        >
          Next image
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </ImagePreviewDialog>
  );
}

/** The Flow input card's prompt with images: reference chips, three thumbnails and a `+N` overflow. */
export function FlowInputPrompt({ run }: { run: RunDetail }) {
  const { openAt, unavailable, markUnavailable, gallery } = useRunImages(run);
  const shown = run.images.slice(0, FLOW_INPUT_THUMBNAILS);
  const hidden = run.images.length - shown.length;
  const showAll = `Show all ${run.images.length} images`;
  return (
    <div className="flex flex-col gap-2 px-3 pb-2.5">
      <p className="line-clamp-3 text-xs leading-4.5 text-foreground" title={runPromptText(run)}>
        <PromptSegments run={run} />
      </p>
      <ul aria-label="Prompt images" className="flex gap-2">
        {shown.map((image, index) => (
          <li key={image.imageId}>
            <RunImageThumbnail
              image={image}
              index={index}
              unavailable={unavailable.has(image.sha256)}
              onUnavailable={markUnavailable}
              onOpen={() => openAt(index)}
            />
          </li>
        ))}
        {hidden > 0 && (
          <li>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={showAll}
                  onClick={() => openAt(FLOW_INPUT_THUMBNAILS)}
                  className="size-9 p-0 text-xs"
                >
                  +{hidden}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{showAll}</TooltipContent>
            </Tooltip>
          </li>
        )}
      </ul>
      {gallery}
    </div>
  );
}

const promptTextClass =
  "font-mono text-xs leading-4.5 break-words whitespace-pre-wrap text-emphasis-foreground";

/** The Run context's initial prompt: the same references and images as the Flow input. */
export function RunInitialPrompt({ run }: { run: RunDetail }) {
  const { openAt, unavailable, markUnavailable, gallery } = useRunImages(run);
  if (!run.images.length) return <pre className={promptTextClass}>{run.input}</pre>;
  return (
    <>
      <pre className={promptTextClass}>
        <PromptSegments run={run} onOpen={openAt} />
      </pre>
      <ul aria-label="Prompt images" className="grid gap-1">
        {run.images.map((image, index) => {
          const label = imageLabel(image, index);
          const missing = unavailable.has(image.sha256);
          return (
            <li key={image.imageId}>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Open ${label}`}
                onClick={() => openAt(index)}
                className="h-auto w-full justify-start gap-2 p-1 text-left"
              >
                <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
                  <ImageSlot image={image} unavailable={missing} onUnavailable={markUnavailable} />
                </span>
                <span className="grid min-w-0">
                  <span className="truncate text-xs text-emphasis-foreground">{label}</span>
                  {missing && (
                    <span className="text-2xs text-muted-foreground">Image unavailable</span>
                  )}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
      {gallery}
    </>
  );
}
