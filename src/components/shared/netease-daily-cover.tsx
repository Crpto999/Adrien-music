import { IconMusicFilled } from "@/components/shared/filled-icons";
import { cn } from "@/lib/utils";

/**
 * The cover art for the NetEase daily picks.
 *
 * The platform's recommendation endpoint returns songs, not a playlist,
 * so there is no artwork to show. Rather than borrow an arbitrary
 * album's cover — which would imply a record the user never picked —
 * the page draws its own tile: a wash in the theme's accent colour with
 * the music mark on it.
 *
 * The mark is centred and slightly off-square, matching the app's
 * other "no artwork" tiles (the mood cards, the category tiles).
 */
export function NeteaseDailyCover({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative grid size-full place-items-center overflow-hidden",
        // The wash follows the theme's accent rather than the platform's
        // own red, so the tile belongs to the theme it is seen in.
        "bg-[linear-gradient(145deg,var(--netease-cover-from)_0%,var(--netease-cover-mid)_55%,var(--netease-cover-to)_100%)]",
        className,
      )}
    >
      {/* A soft highlight in the upper-left corner, so the tile reads
          as a lit surface rather than a flat swatch. */}
      <div
        aria-hidden
        className="absolute -top-1/4 -left-1/4 size-3/4 rounded-full bg-white/15 blur-2xl"
      />
      {/* The glyph's own ink only fills ~73% of its 24×24 box, so the
          box has to be larger than the mark looks for the mark to read
          as a proper focal point on a 148px cover. */}
      <IconMusicFilled className="relative size-4/5 text-white/95 drop-shadow-[0_2px_8px_rgba(0,0,0,0.35)]" />
    </div>
  );
}
