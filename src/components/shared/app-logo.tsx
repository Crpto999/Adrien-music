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
 *
 * Hover tint
 * ----------
 * The monochrome marks are bare letterforms, so there is no colour in
 * them to brighten — the hover state tints the whole glyph with the
 * theme's accent instead.
 *
 * That is done with a mask rather than by shipping a second coloured
 * asset: the white and black SVGs carry the same alpha channel (they
 * are the same shape drawn in different inks), so the SVG doubles as a
 * mask and a `background-color` fills exactly the glyph. `--brand` is
 * the accent the rest of the theme uses — green on the dark ground, red
 * on the light one.
 *
 * The cyberpunk theme keeps its colour mark untouched: there the
 * gradient IS the mark, and a flat accent would flatten it.
 *
 * The group is NAMED (`group/logo`) on purpose: the sidebar that hosts
 * this mark is itself a `group`, and an unnamed `group-hover:` here
 * would also match that outer group — so the mark would light up
 * whenever the mouse was anywhere in the sidebar.
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
  const isColor = themeId === "cyberpunk";
  const src = isColor
    ? "/adrify-logo-color.png"
    : scheme === "light"
      ? "/adrify-logo-black.svg"
      : "/adrify-logo-white.svg";

  return (
    // The wrapper owns the box the caller asked for. The image is the
    // only thing that contributes to its size (the tint overlay is
    // taken out of flow), so the overlay can be laid exactly over the
    // mark with `inset-0`.
    <span
      className={cn("group/logo relative grid place-items-center", className)}
    >
      <img
        src={src}
        alt={alt}
        className={cn(
          "col-start-1 row-start-1 h-auto w-full max-h-full object-contain",
          // The tint cross-fades in over the mark rather than tinting it
          // in place: leaving the original ink underneath would leave a
          // dark fringe on the antialiased edge of the glyph.
          !isColor &&
            "transition-opacity duration-200 group-hover/logo:opacity-0",
        )}
        draggable={false}
      />
      {isColor ? null : (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-brand opacity-0 transition-opacity duration-200 group-hover/logo:opacity-100"
          style={{
            maskImage: `url(${src})`,
            WebkitMaskImage: `url(${src})`,
            maskSize: "contain",
            WebkitMaskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
          }}
        />
      )}
    </span>
  );
}
