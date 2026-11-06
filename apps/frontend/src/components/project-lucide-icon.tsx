import { useEffect, useState } from "react";
import { FolderIcon, Icon, type LucideIconData } from "lucide-react";
import { api } from "../api.ts";

const icons = new Map<string, Promise<LucideIconData>>();

function loadIcon(name: string): Promise<LucideIconData> {
  const cached = icons.get(name);
  if (cached) return cached;
  const request = api.getLucideIcon(name).catch((error: unknown) => {
    icons.delete(name);
    throw error;
  });
  icons.set(name, request);
  return request;
}

export default function ProjectLucideIcon({ name }: { name: string }) {
  const [icon, setIcon] = useState<LucideIconData | null>(null);
  useEffect(() => {
    let active = true;
    void loadIcon(name).then(
      (data) => {
        if (active) setIcon(data);
      },
      () => {
        // Unavailable icons retain the folder fallback, as failed imports did.
      },
    );
    return () => {
      active = false;
    };
  }, [name]);

  return icon ? (
    <Icon icon={icon} className="size-4" strokeWidth={1.5} />
  ) : (
    <FolderIcon className="size-4" strokeWidth={1.5} />
  );
}
