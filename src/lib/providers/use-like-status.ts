import { useQuery } from "@tanstack/react-query";
import {
  fetchLikeStatus,
  type LikeStatus,
} from "@/lib/innertube/like-status";
import {
  knownYouTubeVideoId,
  resolveYouTubeVideoId,
  type LikeStatusTrack,
} from "@/lib/providers/youtube-id";
import { authLoggedInQuery } from "@/lib/store/auth-queries";

/**
 * The YouTube rating for a track, fetched on demand.
 *
 * ## What this replaces
 *
 * The heart used to be filled from a cached copy of the user's entire
 * Liked Songs playlist. That list is a *library-wide* fact used to
 * answer a *per-track* question, and it cost a great deal to keep:
 * 7+ continuation round-trips, a payload too large to persist, and a
 * cache that could be wrong in one direction only — a track liked
 * before the current session showed an unfilled heart.
 *
 * YouTube answers the per-track question directly, so the per-track
 * question is asked directly. The playlist is gone from the hot path.
 *
 * ## Where the answer comes from
 *
 * A track that *is* a YouTube video is asked about by its own id. A
 * track from another platform is first translated into the YouTube
 * recording that holds it (see `providers/youtube-id.ts`), and then
 * asked about under that id — so the heart reflects the user's YouTube
 * rating for the song even when the audio is coming from NetEase.
 *
 * ## Why the answer is allowed to be "unknown"
 *
 * A signed-out user has no ratings to ask about: YouTube answers
 * anonymously, and the answer is `null` — *unknown*, not *not liked*.
 * The distinction matters, because a heart that filled on "unknown"
 * would show a liked song for a signed-in user whose request happened
 * to fail. So `null` is reported as unknown and the heart simply does
 * not fill.
 */

/**
 * How long a rating is considered fresh.
 *
 * A rating changes only when the user changes it, and the app knows
 * when it does — so the cache is patched in place at that moment (see
 * `like-actions.ts`) rather than refetched. The window is a safety net
 * for ratings changed elsewhere.
 */
export const LIKE_STATUS_STALE_TIME = 10 * 60 * 1000;

/**
 * The query key for a track's YouTube rating.
 *
 * Keyed on the *YouTube* id, not on the track: two tracks that resolve
 * to the same YouTube recording are the same question, and the rating
 * is per recording.
 */
export function likeStatusKey(videoId: string) {
  return ["youtube-like-status", videoId] as const;
}

/**
 * A stable key for the "which YouTube video holds this track?" query.
 *
 * The resolution is a property of the *song*, not of the queue slot it
 * sits in — so the key is the track's identity (its platform, its id
 * on that platform, its title and artists) rather than its position.
 * Two rows for the same song therefore share one lookup.
 */
function resolutionKeyOf(track: LikeStatusTrack | undefined): string {
  if (!track) return "";
  const candidate = track as Partial<{
    provider: string;
    providerTrackId: string;
    videoId: string;
    id: string;
    title: string;
    artists: ({ name: string } | string)[];
  }>;
  const artists = (candidate.artists ?? [])
    .map((a) => (typeof a === "string" ? a : a.name))
    .join(",");
  return [
    candidate.provider ?? "youtube",
    candidate.providerTrackId ?? candidate.videoId ?? candidate.id ?? "",
    candidate.title ?? "",
    artists,
  ].join("|");
}

/**
 * The rating for a track.
 *
 * The resolution to a YouTube id is asynchronous for tracks from other
 * platforms, so the rating's query key cannot be known up front. This
 * hook resolves the id first — through its own cached query — and then
 * asks for the rating under the resolved id, which *can* be a stable
 * key.
 *
 * That split is what makes the cache shareable: the rating for a
 * YouTube video is one cache entry, whether the track reached it
 * directly or through a cross-platform match.
 */
export function useTrackLikeStatus(
  track: LikeStatusTrack | undefined,
  options?: {
    /**
     * Skip the lookup entirely.
     *
     * Used when the rating is already known — a signed-in row carries
     * it, so there is nothing left to ask for. The heart fills from the
     * carried value and no request goes out.
     */
    skip?: boolean;
  },
): {
  /** The rating, or `null` when it is not known (yet). */
  status: LikeStatus | null;
  /** True while the question is still in flight. */
  isLoading: boolean;
} {
  // A signed-out user has no ratings to ask about: YouTube answers
  // anonymously, and the answer is "unknown". Asking anyway would cost
  // one request per row on every track list, so the question is not
  // put until there is somebody to answer it.
  const loggedIn = useQuery(authLoggedInQuery);
  const signedIn = loggedIn.data === true;

  // A YouTube track — and a track the app already knows the
  // correspondence for — answers without any lookup at all.
  const knownId = knownYouTubeVideoId(track);
  const skip = options?.skip === true;

  const resolved = useQuery({
    queryKey: ["youtube-video-id", resolutionKeyOf(track)],
    queryFn: (): Promise<string | null> => resolveYouTubeVideoId(track),
    // Only asked when the answer is not already known.
    enabled: !!track && !knownId && !skip && signedIn,
    // The correspondence between a song and its YouTube recording does
    // not change; the app also caches it in the registry, so this is
    // the second line of defence.
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const videoId = knownId ?? resolved.data ?? null;

  const rating = useQuery({
    queryKey: likeStatusKey(videoId ?? ""),
    queryFn: (): Promise<LikeStatus | null> =>
      fetchLikeStatus(videoId as string),
    enabled: !!videoId && !skip && signedIn,
    staleTime: LIKE_STATUS_STALE_TIME,
    retry: false,
  });

  return {
    status: videoId ? (rating.data ?? null) : null,
    isLoading: skip
      ? false
      : videoId
        ? rating.isLoading
        : resolved.isLoading,
  };
}

/**
 * Whether a track is liked on YouTube.
 *
 * `false` for a track whose rating is not known — an unsigned-out
 * session, or a request that failed. The heart stays unfilled in that
 * case, which is the honest answer: the app does not know.
 */
export function isLikedStatus(status: LikeStatus | null | undefined): boolean {
  return status === "LIKE";
}
