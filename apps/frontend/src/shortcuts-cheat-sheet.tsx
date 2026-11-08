import { Link } from "@tanstack/react-router";
import {
  formatShortcut,
  shortcutDefinitions,
  shortcutGroupLabels,
  type ShortcutGroup,
} from "./keyboard-shortcuts.ts";
import { useShortcutPreferences } from "./shortcut-preferences.ts";
import { settingsMask } from "./settings-navigation.ts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";

const groupOrder: ShortcutGroup[] = ["application", "navigation", "runActions", "canvas"];

/** Read-only shortcut reference grouped like Settings → Keyboard shortcuts. */
export function ShortcutsCheatSheet({
  open,
  onOpenChange,
  pathname,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pathname: string;
}) {
  const { bindings } = useShortcutPreferences();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="border-b px-4 py-3 text-base font-semibold">
          Keyboard shortcuts
        </DialogTitle>
        <DialogDescription className="sr-only">
          Factory commands and their current bindings.
        </DialogDescription>
        <div className="max-h-[min(70vh,32rem)] overflow-y-auto px-4 py-3">
          {groupOrder.map((group) => {
            const commands = shortcutDefinitions.filter((command) => command.group === group);
            if (!commands.length) return null;
            return (
              <section key={group} className="pb-4 last:pb-0">
                <h3 className="pb-2 text-2xs font-semibold tracking-section text-subtle-foreground uppercase">
                  {shortcutGroupLabels[group]}
                </h3>
                <dl className="grid gap-1">
                  {commands.map((command) => (
                    <div
                      key={command.id}
                      className="flex items-baseline justify-between gap-3 text-sm"
                    >
                      <dt className="min-w-0 truncate text-foreground">{command.label}</dt>
                      <dd className="shrink-0 font-mono text-2xs text-muted-foreground">
                        {formatShortcut(bindings[command.id])}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
        <p className="border-t px-4 py-3 text-2xs text-muted-foreground">
          <Link
            to={pathname}
            search={{ settings: { tab: "keyboard" } }}
            mask={settingsMask({ tab: "keyboard" })}
            resetScroll={false}
            className="text-link underline"
            onClick={() => onOpenChange(false)}
          >
            Open Settings → Keyboard shortcuts
          </Link>
          {" · "}Esc to close
        </p>
      </DialogContent>
    </Dialog>
  );
}
