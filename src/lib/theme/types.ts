/**
 * The theme system's type vocabulary.
 *
 * A theme is a named bundle of design tokens. The app ships a few
 * built-in ones (light, dark, cyberpunk) and the registry is open, so
 * user-defined themes can be added later without touching any of the
 * parts of the app that pick or apply a theme.
 */

/** Whether a theme paints on a light or a dark ground. */
export type ThemeScheme = "light" | "dark";

/** A registered theme. */
export interface ThemeDefinition {
  /** Stable id; also the value written to the `data-theme` attribute. */
  id: string;
  /** i18n key for the theme's display name. */
  labelKey: string;
  /** Which `dark:`-variant behaviour the theme wants. */
  scheme: ThemeScheme;
  /**
   * Token overrides applied as inline custom properties on the root
   * element. Built-in themes carry their tokens in a stylesheet; this
   * is the channel a user-defined theme writes through.
   */
  tokens?: Record<string, string>;
}

/**
 * The pseudo-theme that follows the OS preference. It is not a
 * registered theme — it resolves to `light` or `dark` at runtime.
 */
export const SYSTEM_THEME_ID = "system";

/** One entry of the theme picker. */
export interface ThemeOption {
  id: string;
  /** i18n key for the label, or the user's own name for a custom theme. */
  labelKey: string;
  scheme: ThemeScheme;
  /** True for a theme the user defined rather than one we ship. */
  custom?: boolean;
}
