import { lazy } from "react";

/**
 * The full-screen now-playing view, loaded on demand.
 *
 * The loader and the preloader share one import specifier — and
 * therefore one chunk — so warming it up actually warms the component
 * that gets mounted.
 */
export const FullscreenPlayer = lazy(() =>
  import("@/components/layout/fullscreen-player").then((mod) => ({
    default: mod.FullscreenPlayer,
  })),
);
