import { createLink } from "@tanstack/react-router";
import { forwardRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import {
  useSettingsOptions,
  useStudioOptions,
  type StudioSelection,
  type SettingsSelection,
} from "../settings-navigation.ts";

const StyledAnchor = forwardRef<HTMLAnchorElement, ComponentProps<"a">>(function StyledAnchor(
  { className, ...props },
  ref,
) {
  return (
    <a
      ref={ref}
      className={cn(
        "rounded-sm text-link underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  );
});
export const AppLink = createLink(StyledAnchor);

export function SettingsLink({
  selection,
  ...props
}: {
  selection: SettingsSelection;
  children: React.ReactNode;
  className?: string;
}) {
  const options = useSettingsOptions(selection);
  return <AppLink {...options} {...props} />;
}

type StudioLinkProps = {
  selection: StudioSelection;
  children: React.ReactNode;
  className?: string;
  "aria-current"?: ComponentProps<"a">["aria-current"];
  "aria-label"?: string;
  "aria-describedby"?: ComponentProps<"a">["aria-describedby"];
};

export function StudioLink({ selection, ...props }: StudioLinkProps) {
  const options = useStudioOptions(selection);
  return <AppLink {...options} {...props} />;
}
