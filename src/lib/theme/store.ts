import { create } from "zustand";
import { persist } from "zustand/middleware";

import { DEFAULT_THEME_ID, isBuiltInTheme } from "./registry";
import { SYSTEM_THEME_ID, type ThemeOption } from "./types";

/**
 * A theme the user defined themselves.
 *
 * The shape is deliberately thin: a name, the scheme it paints on and a
 * flat map of CSS custom properties. That is enough to express any
 * palette, and it keeps the storage format stable as more knobs are
 * added — a saved theme only carries the tokens it actually overrides,
 * so a token added to the app later still resolves to the base theme's
 * value rather than going missing.
 */
export interface CustomTheme {
  id: string;
  /** The user's own name for the theme. */
  name: string;
  /** Which `dark:`-variant behaviour the theme wants. */
  scheme: "light" | "dark";
  /** CSS custom properties, e.g. `{ "--background": "#080A12" }`. */
  tokens: Record<string, string>;
}

type State = {
  /**
   * The theme the user picked. Either a built-in id, `system`, or the
   * id of a saved custom theme.
   */
  themeId: string;
  /** User-defined themes, keyed by id. */
  customThemes: CustomTheme[];
  setThemeId: (id: string) => void;
  saveCustomTheme: (theme: CustomTheme) => void;
  removeCustomTheme: (id: string) => void;
};

/**
 * The theme selection and the user's own themes.
 *
 * Persisted locally: the choice is a decoration of this install, like
 * the interface font or the window glow, and nothing about it round-trips
 * to the account.
 *
 * The store deliberately does *not* apply the theme to the DOM. That is
 * the provider's job (`theme-provider.tsx`), which keeps the concern of
 * "what is selected" separate from "how it is painted".
 */
export const useThemeStore = create<State>()(
  persist(
    (set) => ({
      themeId: DEFAULT_THEME_ID,
      customThemes: [],
      setThemeId: (themeId) => set({ themeId }),
      saveCustomTheme: (theme) =>
        set((s) => {
          const others = s.customThemes.filter((t) => t.id !== theme.id);
          return { customThemes: [...others, theme] };
        }),
      removeCustomTheme: (id) =>
        set((s) => {
          const customThemes = s.customThemes.filter((t) => t.id !== id);
          // A selection pointing at a theme that no longer exists falls
          // back to the default rather than leaving the app unstyled.
          const themeId =
            s.themeId === id ? DEFAULT_THEME_ID : s.themeId;
          return { customThemes, themeId };
        }),
    }),
    { name: "ytm-theme" },
  ),
);

// The main and floating-player windows are separate JS contexts sharing
// the `ytm-theme` localStorage key (same pattern as `ytm-settings`), so
// a theme chosen in one has to reach the other.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "ytm-theme") {
      void useThemeStore.persist.rehydrate();
    }
  });
}

/** The custom theme with this id, if the user saved one. */
export function findCustomTheme(
  themes: CustomTheme[],
  id: string,
): CustomTheme | undefined {
  return themes.find((t) => t.id === id);
}

/**
 * The picker's entries, in display order: the built-in themes first,
 * then the user's own.
 *
 * `system` is not one of them — it is a separate control, because it
 * does not name a palette but a rule for choosing one.
 */
export function themeOptions(
  customThemes: CustomTheme[],
  builtin: readonly { id: string; labelKey: string; scheme: "light" | "dark" }[],
): ThemeOption[] {
  return [
    ...builtin.map((t) => ({
      id: t.id,
      labelKey: t.labelKey,
      scheme: t.scheme,
    })),
    ...customThemes.map((t) => ({
      id: t.id,
      // A custom theme carries the user's own name, not an i18n key, so
      // the picker resolves it through `custom` rather than `labelKey`.
      labelKey: t.name,
      scheme: t.scheme,
      custom: true,
    })),
  ];
}

/** Whether a stored theme id still resolves to something we can paint. */
export function isUsableThemeId(id: string, customThemes: CustomTheme[]) {
  return (
    id === SYSTEM_THEME_ID ||
    isBuiltInTheme(id) ||
    findCustomTheme(customThemes, id) !== undefined
  );
}
