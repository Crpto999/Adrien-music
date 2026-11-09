import { useRef, type ReactNode } from "react";
import { Thumbnail } from "@/components/shared/thumbnail";
import type { Thumbnail as ThumbnailItem } from "@/lib/innertube/types";
import { ArtworkOutline } from "@/components/shared/artwork-outline";
import { cn } from "@/lib/utils";

/**
 * The now-playing artwork, shared by the player card / bottom bar and
 * the full-screen view.
 *
 * The wrapper carries the shadow so it is cast by the cover's rounded
 * box rather than by the Thumbnail's own square edge. `isolate` is
 * load-bearing: the outline below blends, and a blending element
 * turns its nearest stacking-context ancestor into an isolated group,
 * which is also a backdrop root. Without it that group is the m.div
 * wrapping cover AND lyrics, so the lyrics' backdrop-blur strip loses
 * the card and the app background from its backdrop and paints as a
 * dark band.
 */
export function NowPlayingCover({
  track,
  override,
  className,
  children,
  onClick,
}: {
  track: {
    title: string;
    thumbnails: ThumbnailItem[];
  };
  override: string | null;
  className?: string;
  /** Extra content layered over the artwork. */
  children?: ReactNode;
  /** Clicking the artwork itself toggles the full-screen view. */
  onClick?: () => void;
}) {
  const coverRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={coverRef}
      onClick={onClick}
      className={cn(
        "group/cover relative isolate aspect-square w-full rounded-md",
        onClick && "cursor-pointer",
        className,
      )}
    >
      <Thumbnail
        thumbnails={track.thumbnails}
        alt={track.title}
        className="pointer-events-none size-full rounded-[inherit]"
        targetSize={1024}
        highRes
        overrideHighRes={override}
      />
      <ArtworkOutline className="rounded-[inherit]" />
      {children}
    </div>
  );
}
