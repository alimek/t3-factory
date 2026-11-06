import type { FactoryProject } from "@t3-factory/contracts";
import { useState } from "react";
import { FolderIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import ProjectLucideIcon from "./project-lucide-icon.tsx";

type IconData = NonNullable<FactoryProject["projectIcon"]>;
type IconColor = Extract<IconData, { kind: "lucide" | "monogram" }>["color"];

const colors: Record<IconColor, string> = {
  gray: "text-muted-foreground",
  red: "text-red-400",
  orange: "text-orange-400",
  amber: "text-amber-400",
  yellow: "text-yellow-400",
  lime: "text-lime-400",
  green: "text-green-400",
  emerald: "text-emerald-400",
  teal: "text-teal-400",
  cyan: "text-cyan-400",
  sky: "text-sky-400",
  blue: "text-blue-400",
  indigo: "text-indigo-400",
  violet: "text-violet-400",
  purple: "text-purple-400",
  fuchsia: "text-fuchsia-400",
  pink: "text-pink-400",
  rose: "text-rose-400",
};

function FolderFallback() {
  return <FolderIcon className="size-4" strokeWidth={1.5} />;
}

function ProjectFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <FolderFallback />;
  return (
    <img
      data-slot="project-favicon"
      src={url}
      alt=""
      loading="lazy"
      className="size-full rounded-[inherit] object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function IconContent({
  icon,
  faviconUrl,
}: {
  icon: FactoryProject["projectIcon"];
  faviconUrl: FactoryProject["faviconUrl"];
}) {
  if (icon?.kind === "emoji")
    return (
      <span data-slot="project-emoji" className="text-base leading-none">
        {icon.emoji}
      </span>
    );
  if (icon?.kind === "monogram")
    return (
      <span
        data-slot="project-monogram"
        className="max-w-full truncate px-0.5 text-xs font-semibold"
      >
        {icon.text}
      </span>
    );
  if (icon?.kind === "lucide") {
    return <ProjectLucideIcon key={icon.name} name={icon.name} />;
  }
  if (faviconUrl) return <ProjectFavicon key={faviconUrl} url={faviconUrl} />;
  return <FolderFallback />;
}

export function ProjectIcon({
  icon,
  faviconUrl,
  inline = false,
}: {
  icon: FactoryProject["projectIcon"];
  faviconUrl: FactoryProject["faviconUrl"];
  /** 16 px glyph without a tile, as in the launch composer's select fields (Run/SelectField). */
  inline?: boolean;
}) {
  const color = icon && icon.kind !== "emoji" ? colors[icon.color] : "text-muted-foreground";
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center",
        inline
          ? "size-4 rounded-sm [&_[data-slot=project-emoji]]:text-sm [&_[data-slot=project-monogram]]:px-0 [&_[data-slot=project-monogram]]:text-[0.5rem]"
          : "size-7 rounded-md border bg-muted",
        color,
      )}
    >
      <IconContent icon={icon} faviconUrl={faviconUrl} />
    </span>
  );
}
