import type { ShelfItem } from "@/lib/innertube/types";
import type { LastfmTrackMeta } from "@/lib/lastfm/track";
import { findYouTubeVideoId, subjectOf } from "@/lib/providers/netease-like";
import { isYouTubeVideoId } from "@/lib/providers/queue";
import { neteaseVideoForSong } from "@/lib/store/netease-ids";
import type { QueueTrack } from "@/lib/store/playback";

/**
 * Finding the YouTube video behind a track, whatever it came from.
 *
 * ## Why the heart needs this
 *
 * The heart is a YouTube rating. YouTube's rating endpoint only
 * understands YouTube video ids, so the app has to know *which* YouTube
 * video a track is, before it can ask whether that video is liked.
 *
 * For most tracks that is free: the track carries its own YouTube id.
 * But a track from another platform — a NetEase daily pick, say — does
 * not. It carries a synthetic `netease_<id>` in the queue's `videoId`
 * slot, which no YouTube endpoint will ever answer to.
 *
 * So there are two cases, and the second one has to be resolved lazily:
 *
 *   1. A YouTube track: its own `videoId` is the answer.
 *   2. Another platform's track: the app has to find the YouTube
 *      recording that holds the same song.
 *
 * ## Where the answer comes from, in order
 *
 *   1. **The track's own YouTube id**, when it has one — either it is
 *      a YouTube track, or it was discovered on YouTube and plays from
 *      elsewhere.
 *   2. **The correspondence registry** (`store/netease-ids.ts`), which
 *      remembers the NetEase song → YouTube video pairing the app has
 *      already established: a pick the user hearted, a track the user
 *      switched between platforms. This is exact — both ids name one
 *      recording — and it is what the answer usually is.
 *   3. **A catalogue match** (`findYouTubeVideoId`), which searches
 *      YouTube for the song and scores the candidates. This is a
 *      *guess*: it could land on a cover. So it is the last resort, and
 *      the matching rules and their confidence threshold are the ones
 *      the heart's own cross-platform sync already uses.
 */

/** A track as the app holds it, in either the queue's or the row's shape. */
export type LikeStatusTrack = QueueTrack | ShelfItem | LastfmTrackMeta;

/**
 * The track's own YouTube video id, when it has one outright.
 *
 * An explicit provider wins over the id's shape: a NetEase pick that
 * was redirected to YouTube plays *from* YouTube and keeps its YouTube
 * id, so its id is a YouTube id even though the pick was found on
 * NetEase.
 */
function nativeYouTubeId(
  track: LikeStatusTrack | undefined,
): string | undefined {
  if (!track) return undefined;

  const candidate = track as Partial<QueueTrack> & { id?: string };
  const provider = candidate.provider;
  const videoId = candidate.videoId ?? candidate.id;

  // No provider at all means YouTube — the app's convention, and the
  // one every existing consumer already assumes.
  if (!provider) {
    return videoId && isYouTubeVideoId(videoId) ? videoId : undefined;
  }
  if (provider !== "youtube") return undefined;
  return candidate.providerTrackId ?? videoId ?? undefined;
}

/**
 * The NetEase song id a track knows, when it knows one.
 */
function neteaseSongIdOf(
  track: LikeStatusTrack | undefined,
): string | undefined {
  const candidate = track as Partial<QueueTrack> | undefined;
  if (!candidate) return undefined;
  if (candidate.provider === "netease") return candidate.providerTrackId;
  if (candidate.discoveredOn === "netease") return candidate.discoveredTrackId;
  return undefined;
}

/**
 * The YouTube video id for a track, resolved as far as it can be
 * without a network request.
 *
 * Returns `null` when the track is from another platform and the app
 * has not yet established the correspondence — the caller then has to
 * ask the catalogue.
 */
export function knownYouTubeVideoId(
  track: LikeStatusTrack | undefined,
): string | null {
  const native = nativeYouTubeId(track);
  if (native) return native;

  // The registry's answer is exact, and it survives the queue entry
  // being rebuilt — so it is consulted before anything else.
  const songId = neteaseSongIdOf(track);
  if (songId) {
    const videoId = neteaseVideoForSong(songId);
    if (videoId) return videoId;
  }

  return null;
}

/**
 * The YouTube video id for a track, asking YouTube when it has to.
 *
 * The catalogue lookup is cached by `findYouTubeVideoId`, so the
 * second play of the same track costs nothing.
 */
export async function resolveYouTubeVideoId(
  track: LikeStatusTrack | undefined,
): Promise<string | null> {
  const known = knownYouTubeVideoId(track);
  if (known) return known;

  const subject = subjectOf(track);
  if (!subject.title.trim() || subject.artists.length === 0) return null;

  return findYouTubeVideoId(subject);
}
