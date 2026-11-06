import { FolderIcon } from "lucide-react";
import { DynamicIcon, dynamicIconImports, type IconName } from "lucide-react/dynamic";

function isIconName(name: string): name is IconName {
  return Object.hasOwn(dynamicIconImports, name);
}

function FallbackIcon() {
  return <FolderIcon className="size-4" strokeWidth={1.5} />;
}

export default function ProjectLucideIcon({ name }: { name: string }) {
  if (!isIconName(name)) return <FallbackIcon />;
  return <DynamicIcon name={name} className="size-4" strokeWidth={1.5} fallback={FallbackIcon} />;
}
