import { useResolvedThemeId, useThemeScheme } from "@/lib/theme";

/**
 * The app mark.
 *
 * Three variants ship with the brand:
 *
 * - `white` — the pure-white SVG, for dark grounds.
 * - `black` — the pure-black SVG, for light grounds.
 * - `color` — the full-colour PNG, used on the cyberpunk theme where the
 *   neon gradient is the point of the mark.
 *
 * The variant is picked from the active theme's scheme, so the mark
 * stays legible on every theme without the caller having to think
 * about it. `cyberpunk` is a dark scheme but gets the colour mark.
 */
export function AppLogo({
  className = "size-14",
  alt = "",
}: {
  className?: string;
  alt?: string;
}) {
  const scheme = useThemeScheme();
  const themeId = useResolvedThemeId();
  const src =
    themeId === "cyberpunk"
      ? "/adrify-logo-color.png"
      : scheme === "light"
        ? "/adrify-logo-black.svg"
        : "/adrify-logo-white.svg";

  return <img src={src} alt={alt} className={className} draggable={false} />;
}
