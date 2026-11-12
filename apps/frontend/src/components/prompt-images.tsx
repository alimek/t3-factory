import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ImagePlus, X } from "lucide-react";
import type { RunImage } from "@t3-factory/contracts";
import { RUN_IMAGE_LIMIT, RUN_IMAGE_MIME_TYPES } from "@t3-factory/domain-validation";
import type { ImageRejection } from "../run-draft.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

type LoadImage = (imageId: string) => Promise<Blob | undefined>;

/** An object URL for the draft image's saved bytes while the caller is mounted. */
function useImageUrl(load: LoadImage, imageId: string) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let current: string | undefined;
    let active = true;
    load(imageId).then(
      (data) => {
        if (!active || !data) return;
        current = URL.createObjectURL(data);
        setUrl(current);
      },
      () => setUrl(undefined),
    );
    return () => {
      active = false;
      if (current) URL.revokeObjectURL(current);
    };
  }, [load, imageId]);
  return url;
}

function Thumbnail({
  image,
  load,
  locked,
  onOpen,
  onRemove,
}: {
  image: RunImage;
  load: LoadImage;
  locked: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const url = useImageUrl(load, image.imageId);
  const remove = `Remove ${image.name}`;
  return (
    <li className="relative">
      <Button
        type="button"
        variant="outline"
        aria-label={`Preview ${image.name}`}
        onClick={onOpen}
        className="size-14 overflow-hidden rounded-md p-0"
      >
        {url ? <img src={url} alt="" className="size-full object-cover" /> : null}
      </Button>
      {!locked && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="icon-xs"
              aria-label={remove}
              onClick={onRemove}
              className="absolute -top-1.5 -right-1.5 size-5 rounded-full"
            >
              <X aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{remove}</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

/** Full-size image dialog shared by the composer preview and the Run image gallery. */
export function ImagePreviewDialog({
  title,
  onClose,
  onKeyDown,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl" onKeyDown={onKeyDown}>
        <DialogTitle className="truncate pr-6">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          Full-size preview of an attached image.
        </DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export const previewImageClass = "max-h-[70vh] w-full object-contain";

/** Full-size preview of one attached image. */
export function ImagePreview({
  image,
  load,
  onClose,
}: {
  image: RunImage;
  load: LoadImage;
  onClose: () => void;
}) {
  const url = useImageUrl(load, image.imageId);
  return (
    <ImagePreviewDialog title={image.name} onClose={onClose}>
      {url ? <img src={url} alt={image.name} className={previewImageClass} /> : null}
    </ImagePreviewDialog>
  );
}

/** The draft's attached images inside the prompt field; preview stays available while locked. */
export function PromptImageStrip({
  images,
  load,
  locked,
  onPreview,
  onRemove,
}: {
  images: readonly RunImage[];
  load: LoadImage;
  locked: boolean;
  onPreview: (imageId: string) => void;
  onRemove: (imageId: string) => void;
}) {
  if (!images.length) return null;
  return (
    <ul aria-label="Attached images" className="flex flex-wrap gap-2 pt-1.5 pr-1.5">
      {images.map((image) => (
        <Thumbnail
          key={image.imageId}
          image={image}
          load={load}
          locked={locked}
          onOpen={() => onPreview(image.imageId)}
          onRemove={() => onRemove(image.imageId)}
        />
      ))}
    </ul>
  );
}

const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/** Image files dropped on an element; other drags, such as moving selected text, pass through. */
export function useImageDrop(enabled: boolean, onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  return {
    dragging: dragging && enabled,
    handlers: {
      onDragEnter(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      },
      onDragOver(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = enabled ? "copy" : "none";
      },
      onDragLeave(event: DragEvent) {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      onDrop(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        const files = [...event.dataTransfer.files];
        if (enabled && files.length) onFiles(files);
      },
    },
  };
}

export function ImageDropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-ring bg-muted/95">
      <p className="text-sm font-semibold">Drop images to attach</p>
      <p className="text-2xs tracking-label text-muted-foreground">
        PNG, JPEG, GIF or WebP · up to {RUN_IMAGE_LIMIT} images
      </p>
    </div>
  );
}

export function AttachImagesButton({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Attach images"
            className="shrink-0 text-muted-foreground"
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            <ImagePlus aria-hidden strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Attach images</TooltipContent>
      </Tooltip>
      <Input
        ref={input}
        type="file"
        hidden
        multiple
        aria-label="Attach images"
        accept={RUN_IMAGE_MIME_TYPES.join(",")}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

export function ImageRejections({ rejections }: { rejections: readonly ImageRejection[] }) {
  if (!rejections.length) return null;
  return (
    <div role="alert" className="grid gap-0.5 text-2xs text-destructive">
      <p>Not attached (PNG, JPEG, GIF or WebP up to 10 MiB, at most {RUN_IMAGE_LIMIT} images):</p>
      <ul className="grid gap-0.5">
        {rejections.map((rejection, index) => (
          <li key={`${rejection.name}-${index}`}>
            <span className="font-medium">{rejection.name}</span> — {rejection.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
