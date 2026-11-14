import { useState, type MouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  IconHeart,
  IconHeartFilled,
  IconThumbDown,
  IconThumbDownFilled,
  IconThumbUp,
  IconThumbUpFilled,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { toggleDisliked, toggleLiked } from "@/lib/like-actions";
import type { LastfmTrackMeta } from "@/lib/lastfm/track";
import { useTrackMetaStore } from "@/lib/store/track-meta";
import { useDislikesStore } from "@/lib/store/dislikes";
import { useSettingsStore } from "@/lib/store/settings";
import { useNeteaseLikedIds } from "@/lib/providers/netease-liked";
import { useTrackLikeStatus } from "@/lib/providers/use-like-status";
import type { ProviderId } from "@/lib/providers/types";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

type Props = {
  videoId: string;
  className?: string;
  /** Extra classes for each button, e.g. the player footer's shared
   *  `playerIconButton` chrome so the pair matches its neighbours. */
  buttonClassName?: string;
  /** Compact mode uses size-7 ghost buttons (for track rows). Default
   *  is size-9 (for the player bar). */
  compact?: boolean;
  /** When true, only shows if the track is liked OR on hover of the
   *  row. Caller controls hover visibility via CSS; we just render
   *  the buttons and let `group-hover:*` classes do the work. */
  hideUnlessLiked?: boolean;
  /** Title/artist metadata so a like can be mirrored to Last.fm's loved
   *  tracks. Optional — falls back to the play-time track-meta store. */
  meta?: LastfmTrackMeta & {
    /** The platform the track lives on, when it is not YouTube. */
    provider?: ProviderId;
    /** That platform's own id for the track. */
    providerTrackId?: string;
    /**
     * The rating the row already carried, when the response that
     * produced it said so. A signed-in search or browse response
     * carries the user's rating per row, so the heart can be filled
     * without asking for anything.
     */
    likeStatus?: "LIKE" | "DISLIKE" | "INDIFFERENT";
  };
};

export function LikeDislikeButtons({
  videoId,
  className,
  buttonClassName,
  compact,
  hideUnlessLiked,
  meta,
}: Props) {
  const t = useT();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"like" | "dislike" | null>(null);
  // Appearance -> Rating buttons: a heart, or thumbs up + thumbs down.
  const both = useSettingsStore((s) => s.ratingButtons === "both");
  const isDisliked = useDislikesStore((s) => !!s.ids[videoId]);

  // The rating for *this* track, fetched on demand.
  //
  // A NetEase row's heart belongs to the NetEase account, so the
  // NetEase collection is one of the two answers. But the user's
  // YouTube rating for the *same song* is the other one, and it is
  // asked for too — lazily, by translating the track into the
  // YouTube recording that holds it (see `providers/youtube-id.ts`).
  // That way a song is known to be liked no matter which source the
  // audio is coming from.
  const isNetease =
    (meta as { provider?: ProviderId } | undefined)?.provider === "netease";
  const neteaseLiked = useNeteaseLikedIds(isNetease);
  const neteaseSongId =
    (meta as { providerTrackId?: string } | undefined)?.providerTrackId ?? "";

  // The rating the row already carried, if any. It is the answer for
  // a YouTube row that came back from a signed-in response, and it
  // saves the per-track request entirely.
  const carriedStatus =
    (meta as { likeStatus?: "LIKE" | "DISLIKE" | "INDIFFERENT" } | undefined)
      ?.likeStatus ?? undefined;

  const { status } = useTrackLikeStatus(
    meta ?? { videoId, title: "", artists: [] },
    // A row that already carries its rating needs no request at all.
    { skip: carriedStatus !== undefined },
  );

  // The song is liked if either platform says so. The two are kept in
  // step by the heart's own cross-platform sync, so they agree in
  // practice — but either one being on is enough to fill the heart,
  // because the user is telling us the song is one they love.
  const isLiked = isNetease
    ? (neteaseLiked.data?.includes(neteaseSongId) ?? false) ||
      status === "LIKE"
    : (carriedStatus ?? status) === "LIKE";

  const btnSize = compact ? "size-7" : "size-9";
  const iconSize = compact ? "size-3.5" : "size-4";

  const onLike = async (e: MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy("like");
    const wasLiked = isLiked;
    try {
      // Mirror to Last.fm loved tracks. Prefer caller-supplied metadata;
      // fall back to what we remembered at play time (both may be absent
      // for a never-played track, in which case love-sync quietly skips).
      await toggleLiked({
        queryClient: qc,
        videoId,
        wasLiked,
        track: meta ?? useTrackMetaStore.getState().byId[videoId],
      });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(null);
    }
  };

  const onDislike = async (e: MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy("dislike");
    try {
      await toggleDisliked({
        queryClient: qc,
        videoId,
        wasDisliked: isDisliked,
        wasLiked: isLiked,
        track: meta ?? useTrackMetaStore.getState().byId[videoId],
      });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(null);
    }
  };

  const rated = isLiked || (both && isDisliked);
  const hoverVisibility =
    hideUnlessLiked && !rated
      ? "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
      : "";

  const LikeIcon = both
    ? isLiked
      ? IconThumbUpFilled
      : IconThumbUp
    : isLiked
      ? IconHeartFilled
      : IconHeart;
  const DislikeIcon = isDisliked ? IconThumbDownFilled : IconThumbDown;

  return (
    <div className={cn("flex items-center", hoverVisibility, className)}>
      <Button
        variant="ghost"
        size="icon"
        className={cn(btnSize, buttonClassName)}
        onClick={onLike}
        disabled={busy !== null}
        aria-label={isLiked ? t("like.removeFromLiked") : t("like.addToLiked")}
        aria-pressed={isLiked}
      >
        <LikeIcon className={cn(iconSize, isLiked && "text-brand")} />
      </Button>
      {both ? (
        <Button
          variant="ghost"
          size="icon"
          className={cn(btnSize, buttonClassName)}
          onClick={onDislike}
          disabled={busy !== null}
          aria-label={isDisliked ? t("like.removeDislike") : t("like.dislike")}
          aria-pressed={isDisliked}
        >
          <DislikeIcon className={cn(iconSize, isDisliked && "text-t3")} />
        </Button>
      ) : null}
    </div>
  );
}
