/**
 * The desktop preload's bridge, present only for bundled UI in the desktop app. Browsers and
 * remote content never have it; the UI checks for its presence instead of guessing.
 */
import type { FactoryDesktop } from "@t3-factory/contracts/desktop-bridge";

declare global {
  interface Window {
    readonly factoryDesktop?: FactoryDesktop;
  }
}

export const desktopBridge = (): FactoryDesktop | undefined =>
  typeof window === "undefined" ? undefined : window.factoryDesktop;
