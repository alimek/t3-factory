import type { ApplicationUpdate } from "@t3-factory/contracts";

/** Feed notes may be HTML. Read inert template text; never insert feed markup into the UI. */
function notesText(notes: string | null) {
  const template = document.createElement("template");
  template.innerHTML = (notes ?? "")
    .replace(/<br\s*\/?\s*>|<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ");
  template.content.querySelectorAll("script, style, iframe").forEach((node) => node.remove());
  return (
    template.content.textContent?.replace(/\n[ \t]*\n+/g, "\n\n").trim() ||
    "No release notes were provided for this version."
  );
}

export function ReleaseNotes({
  notes,
  compact = false,
}: {
  notes: string | null;
  compact?: boolean;
}) {
  const text = notesText(notes);
  const excerpt = text.split("\n").slice(0, 8).join("\n").slice(0, 500);
  const shortened = compact && excerpt.length < text.length;
  return (
    <div className="grid gap-1 py-2 text-xs">
      <p className="font-medium">What’s new</p>
      <p className="whitespace-pre-wrap break-words">{shortened ? `${excerpt}…` : text}</p>
      {shortened && <p>Full release notes in Settings → Application.</p>}
    </div>
  );
}

/** An updater's state line, notes and last message, for this app or for the server. */
export function UpdateStatus({ update, copy }: { update: ApplicationUpdate; copy: string }) {
  return (
    <>
      <p role="status" className="text-sm">
        {copy}
        {update.version && ` Version ${update.version}.`}
        {update.state === "downloading" &&
          update.progress !== null &&
          ` ${Math.round(update.progress)}%`}
      </p>
      {update.version && <ReleaseNotes notes={update.releaseNotes} />}
      {update.message && <p className="text-xs text-muted-foreground">{update.message}</p>}
    </>
  );
}
