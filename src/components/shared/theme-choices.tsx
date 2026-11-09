import {
  IconDeviceDesktopFilled,
  IconMoonFilled,
  IconSunFilled,
} from "@tabler/icons-react";

import { useT } from "@/lib/i18n";
import {
  BUILT_IN_THEMES,
  SYSTEM_THEME_ID,
  themeOptions,
  useThemeStore,
} from "@/lib/theme";

/**
 * The list of themes, in the order the picker shows them.
 *
 * Shared by the Settings row and the app menu so the two can never
 * disagree about what themes exist. The registry drives it, so a theme
 * added to `registry.ts` shows up in both without another edit.
 */
export function useThemeChoices() {
  const t = useT();
  const customThemes = useThemeStore((s) => s.customThemes);
  const options = themeOptions(customThemes, BUILT_IN_THEMES);
  return {
    options,
    /** The label of a choice: an i18n key for a built-in, a name for a custom one. */
    labelFor: (opt: { labelKey: string; custom?: boolean }) =>
      opt.custom ? opt.labelKey : t(opt.labelKey),
  };
}

/**
 * The glyph that stands for a theme.
 *
 * The cyberpunk theme gets the app's own mark rather than a sun or a
 * moon: it is the one theme that is tied to the logo, and the mark is
 * what makes it recognisable in a list of three.
 */
export function ThemeGlyph({
  id,
  className = "size-4",
}: {
  id: string;
  className?: string;
}) {
  if (id === "cyberpunk") {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 2.6 14.4 8 20.4 8.6 16 12.6 17.3 18.6 12 15.6 6.7 18.6 8 12.6 3.6 8.6 9.6 8Z" />
      </svg>
    );
  }
  if (id === SYSTEM_THEME_ID) {
    return <IconDeviceDesktopFilled className={className} />;
  }
  if (id === "light") {
    return <IconSunFilled className={className} />;
  }
  return <IconMoonFilled className={className} />;
}
