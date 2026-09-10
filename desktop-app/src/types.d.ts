import type { DesktopBridge } from "./shared";

declare global {
  interface Window { desktopBridge: DesktopBridge; }
}

declare module "*.css" {}

export {};
