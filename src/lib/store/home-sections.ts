import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { safeLocalStorage } from "./safe-storage";
import { homeSectionKey, HOME_SECTION_TITLES } from "@/lib/i18n/home-sections";

/**
 * Seed order matching what a typical signed-in home feed shows today.
 *
 * The home feed carries no stable server-side id per shelf (see
 * `lib/innertube/home.ts` — the client-synthesized `Shelf.id` embeds a
 * per-page cursor hash, so it changes across refreshes), so a stable
 * key has to come from somewhere else. `homeSectionKey` maps a shelf's
 * title — in any language the API returned it — onto a canonical id
 * (`home-sections.ts`), and the order below is that canonical list.
 *
 * Titles this user hasn't seen yet (new sections, or dynamic ones like
 * an artist-name shelf) get appended the first time `register` sees
 * them, so they still show up in the reorder list.
 */
export const DEFAULT_HOME_SECTION_ORDER: string[] = HOME_SECTION_TITLES.map(
  (s) => s.id,
);

type State = {
  /** Ordered section keys — index is the user's preferred rank. */
  order: string[];
  /**
   * Sections the user has shielded (hidden from the home feed).
   *
   * A section that is hidden keeps its place in `order` — so
   * un-hiding it puts it back exactly where it was — but the home
   * route skips it when rendering. Reordering and visibility are
   * independent axes: a user may want "Quick picks" at the top *and*
   * "Forgotten favorites" gone entirely.
   */
  hidden: string[];
  /**
   * Becomes `true` the first time the user reorders a section.
   *
   * It gates two things: the home route's eager-load-then-sort
   * behaviour (a section ranked first might live on a later API page,
   * so every page has to be fetched before the feed is drawn) and
   * whether the settings list is treated as "customized" rather than
   * just showing the default order.
   *
   * Visibility is deliberately *not* part of this flag: shielding a
   * section does not change the order of anything, so it must not
   * force the home feed to fetch every page before it renders.
   */
  customized: boolean;
  /** Move the title at `from` to `to`, splice-style (same shape as
   *  `pinned-playlists.ts`'s `reorder`). */
  reorder: (from: number, to: number) => void;
  /** Append any keys not already known, preserving their relative
   *  order — called as the home feed loads so newly-seen or rotated
   *  sections still show up in the settings list. */
  register: (keys: string[]) => void;
  /** Shield (hide) a section from the home feed. */
  hide: (key: string) => void;
  /** Bring a shielded section back. */
  unhide: (key: string) => void;
  /** Flip a section's visibility. */
  toggleHidden: (key: string) => void;
  /** Back to the seed order, un-hide everything, and un-set
   *  `customized` so the home route goes back to plain lazy infinite
   *  scroll. */
  resetToDefault: () => void;
};

export const useHomeSectionsStore = create<State>()(
  persist(
    (set) => ({
      order: DEFAULT_HOME_SECTION_ORDER,
      hidden: [],
      customized: false,
      reorder: (from, to) =>
        set((s) => {
          if (from === to || from < 0 || to < 0) return s;
          if (from >= s.order.length || to >= s.order.length) return s;
          const next = s.order.slice();
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          return { order: next, customized: true };
        }),
      register: (keys) =>
        set((s) => {
          const known = new Set(s.order);
          const additions = keys.filter((k) => k && !known.has(k));
          if (additions.length === 0) return s;
          return { order: [...s.order, ...additions] };
        }),
      hide: (key) =>
        set((s) => {
          if (!key || s.hidden.includes(key)) return s;
          // Visibility does not touch `customized`: shielding a section
          // leaves the order of everything else alone, so the home feed
          // must not switch into its eager-load-every-page mode.
          return { hidden: [...s.hidden, key] };
        }),
      unhide: (key) =>
        set((s) => {
          if (!s.hidden.includes(key)) return s;
          return { hidden: s.hidden.filter((k) => k !== key) };
        }),
      toggleHidden: (key) =>
        set((s) =>
          s.hidden.includes(key)
            ? { hidden: s.hidden.filter((k) => k !== key) }
            : { hidden: [...s.hidden, key] },
        ),
      resetToDefault: () =>
        set({
          order: DEFAULT_HOME_SECTION_ORDER,
          hidden: [],
          customized: false,
        }),
    }),
    {
      name: "ytm-home-order",
      // `register` writes from inside the Home route's effect on every
      // page load (see `routes/index.tsx`) — the same "runs from a
      // passive effect, not a user click" shape as `track-meta.ts`. WebKitGTK's storage quota is tight enough that
      // an unguarded write there can throw straight past this store into
      // the router's error boundary; `safeLocalStorage` swallows that
      // instead (see its doc comment for the full story).
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (s) => ({
        order: s.order,
        hidden: s.hidden,
        customized: s.customized,
      }),
      /**
       * Orders saved before the locale work were keyed on the shelf's
       * *title*, which broke as soon as the app spoke another language
       * (the API returns titles in the active locale). Map those old
       * titles onto the canonical ids so an existing user's ordering
       * survives the upgrade.
       */
      migrate: (persisted) => {
        const state = persisted as { order?: unknown; hidden?: unknown };
        if (!state || !Array.isArray(state.order)) return persisted;
        const order = (state.order as string[]).map((entry) =>
          homeSectionKey(entry),
        );
        // `hidden` was added after the first release of this store. An
        // older blob simply omits it, and persist's shallow merge fills
        // the gap with the initial `[]` — no version bump needed. But a
        // blob that *has* it may still carry old titles, so map those
        // onto canonical ids the same way the order is mapped.
        const hidden = Array.isArray(state.hidden)
          ? (state.hidden as string[]).map((entry) => homeSectionKey(entry))
          : [];
        return { ...(persisted as object), order, hidden };
      },
      version: 1,
    },
  ),
);

// The main and floating-player windows are separate JS contexts sharing
// the `ytm-home-order` localStorage key (same pattern as `settings.ts`
// and `layout.ts`). The floating window never renders the home feed,
// but keeping this in sync costs nothing and avoids a stale read if
// that ever changes.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "ytm-home-order") {
      void useHomeSectionsStore.persist.rehydrate();
    }
  });
}
