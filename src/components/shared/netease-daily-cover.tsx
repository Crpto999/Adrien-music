import { IconMusicFilled } from "@/components/shared/filled-icons";
import { cn } from "@/lib/utils";

/**
 * The cover art for the NetEase daily picks.
 *
 * The platform's recommendation endpoint returns songs, not a playlist,
 * so there is no artwork to show. Rather than borrow an arbitrary
 * album's cover — which would imply a record the user never picked —
 * the page draws its own tile: the NetEase platform red with the
 * music mark on it.
 *
 * The mark is centred and slightly off-square, matching the app's
 * other "no artwork" tiles (the mood cards, the category tiles).
 */
export function NeteaseDailyCover({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative grid size-full place-items-center overflow-hidden",
        "bg-[linear-gradient(145deg,#e8544a_0%,#c9302c_55%,#8f1d21_100%)]",
        className,
      )}
    >
      {/* A soft highlight in the upper-left corner, so the tile reads
          as a lit surface rather than a flat swatch. */}
      <div
        aria-hidden
        className="absolute -top-1/4 -left-1/4 size-3/4 rounded-full bg-white/15 blur-2xl"
      />
      <IconMusicFilled className="relative size-1/2 text-white/95 drop-shadow-[0_2px_8px_rgba(0,0,0,0.35)]" />
    </div>
  );
}
