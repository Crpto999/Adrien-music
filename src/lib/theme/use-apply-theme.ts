import { useEffect, useMemo } from "react";

import { BUILT_IN_THEMES, isBuiltInTheme } from "./registry";
import { findCustomTheme, useThemeStore } from "./store";
import { SYSTEM_THEME_ID, type ThemeScheme } from "./types";

/**
 * The theme id that is actually painted.
 *
 * `system` resolves against the OS preference; every other id paints
 * itself.
 */
export function resolveThemeId(
  themeId: string,
  systemPrefersDark: boolean,
): string {
  if (themeId === SYSTEM_THEME_ID) {
    return systemPrefersDark ? "dark" : "light";
  }
  return themeId;
}

/** The scheme a theme paints on, which decides the `dark:` variants. */
export function resolveScheme(
  themeId: string,
  systemPrefersDark: boolean,
): ThemeScheme {
  const resolved = resolveThemeId(themeId, systemPrefersDark);
  const builtin = BUILT_IN_THEMES.find((t) => t.id === resolved);
  if (builtin) return builtin.scheme;
  const custom = useThemeStore.getState().customThemes.find(
    (t) => t.id === resolved,
  );
  return custom?.scheme ?? "dark";
}

/**
 * The custom properties the active custom theme wrote onto the root.
 *
 * Tracked so they can be removed again when the theme changes: a custom
 * theme may override any token (`--background`, `--acc1`, …), so the
 * names are not known in advance and cannot be matched by prefix.
 */
let appliedTokenNames: string[] = [];

/**
 * Applies the selected theme to the document.
 *
 * The DOM carries two things: a class and a `data-theme` attribute.
 *
 * - The class is what the stylesheet keys on (`dark`, `cyberpunk`), and
 *   it is also what Tailwind's `dark:` variant reads, so the class has to
 *   be one of `light` / `dark` for that variant to work — a theme that
 *   paints on a dark ground gets the `dark` class even when it is not
 *   the built-in dark theme.
 * - The attribute is the theme's own identity, so the stylesheet can key
 *   a block on `.theme-cyberpunk` and so the app can tell which theme is
 *   active (used to pick the logo variant, for instance).
 *
 * Custom themes write their tokens straight onto the root element as
 * inline custom properties, which sit above every stylesheet block, so
 * they override the built-in palettes without a stylesheet of their own.
 */
export function useApplyTheme() {
  const themeId = useThemeStore((s) => s.themeId);
  const customThemes = useThemeStore((s) => s.customThemes);

  // The tokens of the active custom theme, or nothing for a built-in one.
  const tokens = useMemo(() => {
    const custom = findCustomTheme(customThemes, themeId);
    return custom?.tokens ?? null;
  }, [customThemes, themeId]);

  useEffect(() => {
    const root = document.documentElement;

    const apply = () => {
      const prefersDark = window.matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches;
      const resolved = resolveThemeId(themeId, prefersDark);
      const scheme = resolveScheme(themeId, prefersDark);

      // Tailwind's `dark:` variant keys on the `.dark` class, so a dark
      // scheme has to carry it whichever theme it actually is.
      root.classList.remove("light", "dark");
      root.classList.add(scheme);

      // The theme's own identity, for the stylesheet and for the logo
      // variant the app picks.
      root.setAttribute("data-theme", resolved);
      root.style.colorScheme = scheme;

      // Custom tokens: written as inline custom properties on the root,
      // which outrank every stylesheet declaration. The previous theme's
      // tokens are removed first, so switching themes cannot leave a
      // stale override behind.
      for (const name of appliedTokenNames) {
        root.style.removeProperty(name);
      }
      appliedTokenNames = [];
      if (tokens) {
        for (const [name, value] of Object.entries(tokens)) {
          root.style.setProperty(name, value);
          appliedTokenNames.push(name);
        }
      }
    };

    apply();

    // `system` has to follow the OS while the app is running.
    if (themeId !== SYSTEM_THEME_ID) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themeId, tokens]);
}

/**
 * The theme id that is painted right now, resolved against the OS
 * preference. Reactive: it re-renders when the selection changes.
 */
export function useResolvedThemeId(): string {
  const themeId = useThemeStore((s) => s.themeId);
  const customThemes = useThemeStore((s) => s.customThemes);

  return useMemo(() => {
    if (typeof window === "undefined") {
      return themeId === SYSTEM_THEME_ID ? "dark" : themeId;
    }
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = resolveThemeId(themeId, prefersDark);
    // An unknown id would leave the app unstyled; fall back to the
    // default rather than painting nothing.
    if (
      resolved !== SYSTEM_THEME_ID &&
      !isBuiltInTheme(resolved) &&
      findCustomTheme(customThemes, resolved) === undefined
    ) {
      return "dark";
    }
    return resolved;
  }, [themeId, customThemes]);
}

/**
 * The scheme the active theme paints on. Reactive.
 */
export function useThemeScheme(): ThemeScheme {
  const themeId = useThemeStore((s) => s.themeId);
  const customThemes = useThemeStore((s) => s.customThemes);
  return useMemo(() => {
    if (typeof window === "undefined") return "dark";
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = resolveThemeId(themeId, prefersDark);
    const builtin = BUILT_IN_THEMES.find((t) => t.id === resolved);
    if (builtin) return builtin.scheme;
    return (
      findCustomTheme(customThemes, resolved)?.scheme ?? "dark"
    );
  }, [themeId, customThemes]);
}
