import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The design system's font sizes beyond Tailwind's scale (`--text-*` in styles.css). Without
 * them tailwind-merge reads `text-label` as a color and drops the real color or keeps two sizes.
 */
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["overline", "label", "title", "heading"] } },
});

/** Merges conditional class names and resolves conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
