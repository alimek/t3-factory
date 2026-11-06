import { desktopBridge } from "../desktop-bridge.ts";

/** Bundled macOS chrome. Native window controls occupy the first 88 px. */
export function DesktopTitlebar({ floating = false }: { floating?: boolean }) {
  if (!desktopBridge()) return null;
  return (
    <header
      className={floating ? "desktop-titlebar desktop-titlebar-floating" : "desktop-titlebar"}
      aria-label="Factory window title bar"
    >
      <div className="flex items-center gap-1">
        <img src="/factory-mark.svg" width={24} height={24} alt="" draggable={false} />
        <span className="text-base leading-6 font-semibold tracking-tight">Factory</span>
      </div>
    </header>
  );
}
