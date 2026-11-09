import { create } from "zustand";

/**
 * Where the now-playing cover sat when the full-screen view was
 * opened from.
 *
 * The full-screen view is a single overlay, but it can be entered
 * from two very different places, and the difference is not
 * cosmetic: the cover has to travel to its new home, and the
 * direction it travels in is what the transition (and the arrow on
 * the artwork) is made of.
 *
 * - `bottom` — the bottom bar's cover. The bar hugs the bottom
 *   edge, so the cover travels UP into the view.
 * - `right` — the side card's cover. The card hugs the right edge,
 *   so the cover travels LEFT into the view.
 *
 * The arrow on the artwork always points where the cover is about to
 * go: up from the bottom bar, left from the side card, and the
 * reverse of that when collapsing back.
 */
export type FullscreenOrigin = "bottom" | "right";

type State = {
  open: boolean;
  /** Where the cover came from. Set when the view is opened. */
  origin: FullscreenOrigin;
  setOpen: (open: boolean) => void;
  setOrigin: (origin: FullscreenOrigin) => void;
};

/**
 * Whether the full-screen now-playing view is up. Ephemeral: it is
 * opened from the player card's cover, the bottom bar's cover, and
 * closed by its own Exit pill or Escape, so it lives in a store
 * rather than any one of those components.
 */
export const useFullscreenStore = create<State>()((set) => ({
  open: false,
  origin: "right",
  setOpen: (open) => set({ open }),
  setOrigin: (origin) => set({ origin }),
}));

export function openFullscreen(origin: FullscreenOrigin = "right"): void {
  useFullscreenStore.setState({ open: true, origin });
}
