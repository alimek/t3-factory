import {
  useCallback,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { SearchIcon } from "lucide-react";
import { DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function PickerMenuSearch({
  ariaLabel,
  placeholder,
  value,
  onChange,
  inputRef,
  listRef,
  firstChoiceSelector,
}: {
  ariaLabel: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  firstChoiceSelector: string;
}) {
  return (
    <div className="shrink-0 border-b p-2">
      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={inputRef}
          type="search"
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={value}
          className="h-9 pl-8"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") return;
            event.stopPropagation();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              const choice =
                listRef.current?.querySelector<HTMLElement>(firstChoiceSelector) ??
                listRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]');
              choice?.focus();
            }
          }}
        />
      </div>
    </div>
  );
}

function usePickerMenuContentHandlers({
  searchRef,
  listRef,
  searchEnabled,
}: {
  searchRef: RefObject<HTMLInputElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  searchEnabled: boolean;
}) {
  const onFocusCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (!searchEnabled || event.target !== event.currentTarget) return;
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
    },
    [searchEnabled, searchRef],
  );
  const onPointerMoveCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (document.activeElement === searchRef.current) event.preventDefault();
    },
    [searchRef],
  );
  const onKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowUp") return;
      if (event.target !== listRef.current?.querySelector('[role="menuitemradio"]')) return;
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
    },
    [listRef, searchRef],
  );
  return { onFocusCapture, onPointerMoveCapture, onKeyDownCapture };
}

export function PickerMenuContent({
  className,
  searchRef,
  listRef,
  searchEnabled,
  children,
}: {
  className?: string;
  searchRef: RefObject<HTMLInputElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  searchEnabled: boolean;
  children: ReactNode;
}) {
  const menuHandlers = usePickerMenuContentHandlers({ searchRef, listRef, searchEnabled });
  return (
    <DropdownMenuContent align="start" className={cn(className)} {...menuHandlers}>
      {children}
    </DropdownMenuContent>
  );
}
