import type { ThemeDefinition } from "./types";
import { SYSTEM_THEME_ID } from "./types";

/**
 * The registry of themes the app ships with.
 *
 * A built-in theme is described by two things: its id (which becomes the
 * `data-theme` attribute and the CSS class on the root element) and the
 * scheme it paints on. The actual colours live in `index.css` next to
 * the other token blocks, so a theme reads the same way in the
 * stylesheet as it does here.
 *
 * Adding a theme is therefore two steps: drop a `.theme-<id>` token
 * block into `index.css` and add an entry here. Nothing else in the app
 * needs to know about it — the picker, the menu and the persistence all
 * read the registry.
 */
export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [
  {
    id: "light",
    labelKey: "theme.light",
    scheme: "light",
  },
  {
    id: "dark",
    labelKey: "theme.dark",
    scheme: "dark",
  },
  {
    id: "cyberpunk",
    labelKey: "theme.cyberpunk",
    scheme: "dark",
  },
];

/** The theme the app starts on when nothing has been chosen yet. */
export const DEFAULT_THEME_ID = "dark";

/**
 * The theme whose token block in `index.css` is the base for a given
 * scheme. `light` and `dark` carry their own blocks; every other theme
 * layers on top of one of them.
 */
export const BASE_THEME_BY_SCHEME = {
  light: "light",
  dark: "dark",
} as const;

/** Whether a theme id is one we ship. */
export function isBuiltInTheme(id: string): boolean {
  return BUILT_IN_THEMES.some((t) => t.id === id);
}

/**
 * The theme ids that need a class on the root element, i.e. everything
 * except `system` (which resolves to `light` or `dark` at runtime).
 */
export function isConcreteTheme(id: string): boolean {
  return id !== SYSTEM_THEME_ID;
}
