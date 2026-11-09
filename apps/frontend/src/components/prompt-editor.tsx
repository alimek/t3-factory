import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type Ref,
  type RefObject,
} from "react";
import type { PromptSegment, RunImage } from "@t3-factory/contracts";
import { joinedSegments, type PlaceReferences } from "../run-draft.ts";
import { cn } from "../lib/utils.ts";

export interface PromptEditorHandle {
  focus(): void;
  /** Attaches images and references each accepted one at the last caret, or at the end. */
  insertImages(files: readonly File[]): Promise<void>;
}

const referenceSelector = "[data-image-id]";

/** Binary units, like the 10 MiB image limit. */
function imageSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** An atomic, clickable reference; its label comes from the manifest in `labelReferences`. */
function referenceNode(imageId: string) {
  const reference = document.createElement("span");
  reference.contentEditable = "false";
  reference.dataset.imageId = imageId;
  reference.tabIndex = 0;
  reference.setAttribute("role", "button");
  reference.className =
    "mx-px inline-flex max-w-full cursor-pointer items-baseline gap-1 rounded-sm bg-brand-soft px-1 align-baseline text-sm text-link outline-none select-none hover:ring-1 hover:ring-brand-soft-border focus-visible:ring-2 focus-visible:ring-ring";
  const name = document.createElement("span");
  name.className = "max-w-56 truncate font-medium";
  const detail = document.createElement("span");
  detail.className = "shrink-0 text-2xs text-muted-foreground";
  reference.append(name, detail);
  return reference;
}

/**
 * Names each reference after its image, with the manifest position workers read as `[Image N]`,
 * so references to different images with the same name stay distinguishable.
 */
function labelReferences(root: HTMLElement, images: readonly RunImage[]) {
  for (const reference of root.querySelectorAll<HTMLElement>(referenceSelector)) {
    const index = images.findIndex((candidate) => candidate.imageId === reference.dataset.imageId);
    const image = images[index];
    const name = image?.name ?? "Missing image";
    const detail = image ? `Image ${index + 1} · ${imageSize(image.sizeBytes)}` : "";
    if (reference.dataset.label === `${name}\n${detail}`) continue;
    reference.dataset.label = `${name}\n${detail}`;
    reference.setAttribute("aria-label", `Preview reference ${name}`);
    reference.setAttribute("aria-description", detail);
    const [nameNode, detailNode] = reference.children;
    if (nameNode) nameNode.textContent = name;
    if (detailNode) detailNode.textContent = detail;
  }
}

/**
 * The segments the editor's DOM spells. Browsers may break lines with `<br>` or block elements.
 * A last `<br>`, or a last newline in the final text, only holds an empty last line open: it is
 * not shown as a line of its own and adds no text.
 */
function readSegments(root: HTMLElement): PromptSegment[] {
  // Browsers may leave empty text nodes after the placeholder.
  let tail = root.lastChild;
  while (tail instanceof Text && !tail.data) tail = tail.previousSibling;
  const segments: PromptSegment[] = [];
  for (const node of root.childNodes) readNode(node, tail, segments);
  return joinedSegments(segments);
}

function readNode(node: Node, tail: Node | null, segments: PromptSegment[]) {
  const text = (value: string) => segments.push({ type: "text", text: value });
  if (node instanceof Text) {
    text(node === tail ? node.data.replace(/\n$/, "") : node.data);
  } else if (node instanceof HTMLElement && node.dataset.imageId) {
    segments.push({ type: "image", imageId: node.dataset.imageId });
  } else if (node instanceof HTMLBRElement) {
    if (node !== tail) text("\n");
  } else if (node instanceof HTMLElement) {
    if ((node.tagName === "DIV" || node.tagName === "P") && segments.length) text("\n");
    for (const child of node.childNodes) readNode(child, tail, segments);
  }
}

function writeSegments(root: HTMLElement, segments: readonly PromptSegment[]) {
  root.replaceChildren(
    ...segments.map((segment) =>
      segment.type === "text"
        ? document.createTextNode(segment.text)
        : referenceNode(segment.imageId),
    ),
  );
  const last = segments.at(-1);
  // A final newline shows as an empty line only when a placeholder newline follows it.
  if (last?.type === "text" && last.text.endsWith("\n")) root.append("\n");
}

const sameSegments = (a: readonly PromptSegment[], b: readonly PromptSegment[]) =>
  a.length === b.length &&
  a.every((segment, index) => {
    const other = b[index]!;
    return segment.type === "text"
      ? other.type === "text" && other.text === segment.text
      : other.type === "image" && other.imageId === segment.imageId;
  });

function endOf(root: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

/**
 * Focuses the editor with the caret after its content. Unless `force`d, an editor that already
 * holds the focus keeps its caret.
 */
function focusAtEnd(root: HTMLElement, force = false) {
  if (!force && root.contains(document.activeElement)) return;
  root.focus();
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(endOf(root));
}

/**
 * Rewrites `element` from `segments` only when they differ from what it spells (`shown`), so
 * typing keeps the caret. Returns whether it rewrote.
 */
function showSegments(
  element: HTMLElement,
  shown: { current: readonly PromptSegment[] | undefined },
  segments: readonly PromptSegment[],
) {
  if (shown.current && sameSegments(shown.current, segments)) return false;
  writeSegments(element, segments);
  shown.current = segments;
  return true;
}

/**
 * Places the caret at the end of `root` whenever a draft opens, including the first mount.
 * `last` is the last selection inside it; a live Range follows later edits. Each commit reports
 * through `contentReplaced` whether it rewrote the editor: opening another draft does, while a
 * fresh draft receiving its id as the user types does not, so only the latter keeps the caret.
 */
function useCaret(root: RefObject<HTMLElement | null>, draftId: string | undefined) {
  const last = useRef<Range>(undefined);
  const replaced = useRef(false);
  useEffect(() => focusAtEnd(root.current!, replaced.current), [root, draftId]);
  useEffect(() => {
    const remember = () => {
      const selection = document.getSelection();
      if (selection?.rangeCount && root.current?.contains(selection.anchorNode))
        last.current = selection.getRangeAt(0).cloneRange();
    };
    document.addEventListener("selectionchange", remember);
    return () => document.removeEventListener("selectionchange", remember);
  }, [root]);
  const contentReplaced = (value: boolean) => {
    replaced.current = value;
  };
  return { last, contentReplaced };
}

/** Inserts a reference to each image at `at`, each followed by a space, with the caret after. */
function insertReferences(
  root: HTMLElement,
  at: Range,
  imageIds: readonly string[],
  replaceSelection: boolean,
) {
  const range = root.contains(at.startContainer) ? at : endOf(root);
  if (replaceSelection) range.deleteContents();
  else range.collapse(false);
  const inserted = document.createDocumentFragment();
  for (const imageId of imageIds) inserted.append(referenceNode(imageId), " ");
  const last = inserted.lastChild!;
  range.insertNode(inserted);
  root.focus();
  range.setStartAfter(last);
  range.collapse(true);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
}

const referencedImage = (target: EventTarget) =>
  target instanceof Element
    ? target.closest<HTMLElement>(referenceSelector)?.dataset.imageId
    : undefined;

/**
 * The initial prompt as text with inline image references. The DOM is the editing surface; it
 * is rewritten from `segments` only when they differ from what it spells, so typing keeps the
 * caret. Editor HTML is never saved: every edit is read back as segments.
 */
export function PromptEditor({
  ref,
  draftId,
  segments,
  images,
  locked,
  invalid,
  labelledBy,
  describedBy,
  placeholder,
  onChange,
  attachImages,
  onPreview,
}: {
  ref: Ref<PromptEditorHandle>;
  draftId: string | undefined;
  segments: readonly PromptSegment[];
  images: readonly RunImage[];
  locked: boolean;
  invalid: boolean;
  labelledBy: string;
  describedBy: string;
  placeholder: string;
  /** False when the draft kept its content instead. */
  onChange: (segments: readonly PromptSegment[]) => boolean;
  attachImages: (files: readonly File[], reference: PlaceReferences) => Promise<void>;
  onPreview: (imageId: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const shown = useRef<readonly PromptSegment[]>(undefined);
  const caret = useCaret(root, draftId);

  useLayoutEffect(() => {
    const element = root.current!;
    caret.contentReplaced(showSegments(element, shown, segments));
    labelReferences(element, images);
  });

  function changed() {
    const element = root.current!;
    const next = readSegments(element);
    // An emptied editor may keep a stray `<br>`; clearing it shows the placeholder.
    if (!next.length && element.firstChild) element.replaceChildren();
    shown.current = next;
    if (onChange(next)) return;
    writeSegments(element, segments);
    shown.current = segments;
    labelReferences(element, images);
  }

  async function insertImages(files: readonly File[], replaceSelection = false) {
    const element = root.current;
    if (!element) return;
    const saved = caret.last.current;
    const at = saved && element.contains(saved.startContainer) ? saved : endOf(element);
    await attachImages(files, (attached) => {
      if (!element.isConnected) return undefined;
      insertReferences(element, at, attached, replaceSelection);
      shown.current = readSegments(element);
      return shown.current;
    });
  }

  useImperativeHandle(ref, () => ({
    focus: () => focusAtEnd(root.current!),
    insertImages: (files) => insertImages(files),
  }));

  function openReference(target: EventTarget) {
    const imageId = referencedImage(target);
    if (imageId) onPreview(imageId);
    return !!imageId;
  }

  return (
    <div
      ref={root}
      id="launch-prompt"
      role="textbox"
      aria-multiline
      aria-required
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      aria-readonly={locked}
      aria-placeholder={placeholder}
      data-placeholder={placeholder}
      contentEditable={locked ? "false" : "plaintext-only"}
      suppressContentEditableWarning
      spellCheck
      onInput={changed}
      onPaste={(event) => {
        const files = [...event.clipboardData.files];
        if (!files.length) return;
        event.preventDefault();
        if (!locked) void insertImages(files, true);
      }}
      onClick={(event) => openReference(event.target)}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && openReference(event.target))
          event.preventDefault();
      }}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto text-base leading-relaxed break-words whitespace-pre-wrap outline-none",
        "empty:before:pointer-events-none empty:before:text-subtle-foreground empty:before:content-[attr(data-placeholder)]",
        images.length > 0 && "min-h-20",
      )}
    />
  );
}
