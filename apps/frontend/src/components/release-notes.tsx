/** Feed notes may be HTML. Read inert template text; never insert feed markup into the UI. */
function notesText(notes: string) {
  const template = document.createElement("template");
  template.innerHTML = notes
    .replace(/<br\s*\/?\s*>|<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ");
  template.content.querySelectorAll("script, style, iframe").forEach((node) => node.remove());
  return template.content.textContent ?? "";
}

/**
 * One readable line per change: GitHub's "by @user in <url>", PR and commit references and the
 * Conventional Commit prefix are dropped, so "feat(ui): faster startup by @a in …" reads
 * "Faster startup".
 */
function changeLine(item: string) {
  const text = item
    .replace(/\s+by @\S+ in https?:\/\/\S+$/, "")
    .replace(/(\s*\((?:#\d+|[0-9a-f]{7,40})\))+$/, "")
    .replace(/^[\w-]+(?:\([^)]*\))?!?:\s+/, "")
    .trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Changes listed in every release's notes, newest release first, and how many releases. */
function changes(notes: string | null) {
  const lines = notes ? notesText(notes).split("\n") : [];
  const items = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("• ") && !line.includes("made their first contribution"))
    .map((line) => changeLine(line.slice(2)))
    .filter(Boolean);
  const releases = lines.filter((line) => /^v?\d+\.\d+\.\d+\S*$/.test(line.trim())).length;
  return { items, releases };
}

const previewLimit = 4;

/** A tooltip-sized changelog: a few one-line changes and how many more the update brings. */
export function ChangelogPreview({ notes }: { notes: string | null }) {
  const { items, releases } = changes(notes);
  if (items.length === 0)
    return <p className="text-muted-foreground">No release notes for this version.</p>;
  const hidden = items.length - previewLimit;
  return (
    <div className="grid gap-1">
      <ul className="grid gap-0.5">
        {items.slice(0, previewLimit).map((item) => (
          <li key={item} className="flex gap-1.5">
            <span aria-hidden className="text-muted-foreground">
              •
            </span>
            <span className="line-clamp-2">{item}</span>
          </li>
        ))}
      </ul>
      {(hidden > 0 || releases > 1) && (
        <p className="text-muted-foreground">
          {[hidden > 0 && `+${hidden} more`, releases > 1 && `across ${releases} releases`]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
    </div>
  );
}
