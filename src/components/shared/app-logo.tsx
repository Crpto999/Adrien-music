import { useResolvedThemeId, useThemeScheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

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
 *
 * The white and black marks are the bare letterform (289×278), while
 * the colour mark is the full icon on its plate (360×360) — so the two
 * are not the same shape. `object-contain` keeps whichever is loaded
 * from being stretched to a square box by a caller that sets both a
 * width and a height.
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

  return (
    <img
      src={src}
      alt={alt}
      className={cn("object-contain", className)}
      draggable={false}
    />
  );
}
