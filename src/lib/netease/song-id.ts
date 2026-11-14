import { useQuery } from "@tanstack/react-query";
import { findNeteaseSongId, subjectOf } from "@/lib/providers/netease-like";
import { useNetEaseIdStore } from "@/lib/store/netease-ids";
import type { QueueTrack } from "@/lib/store/playback";

/**
 * The NetEase song id for a track, when there is one.
 *
 * ## Why this is its own module
 *
 * The comments and the 百科 are keyed on the platform's *own* song id,
 * so something has to turn a track into one before they can be fetched.
 * There are three ways to do that, and they are tried in this order:
 *
 *   1. **The track came from NetEase.** Its id is right there —
 *      `providerTrackId` for a track that plays from NetEase,
 *      `discoveredTrackId` for one that was *discovered* there and
 *      redirected elsewhere. No lookup at all: the id is authoritative,
 *      because it says which recording this actually is, and a fresh
 *      catalogue search could land on a cover of the same song.
 *   2. **The app already knows the correspondence.** The registry
 *      (`useNetEaseIdStore`) remembers which NetEase recording a
 *      YouTube video holds. A NetEase daily pick that was hearted on
 *      YouTube comes back from the liked list as an ordinary YouTube
 *      row with no memory of where it came from — but the registry
 *      still knows, and the comments under that recording are the right
 *      ones.
 *   3. **The track is from YouTube and nothing is known about it.** The
 *      app's own cross-platform matcher is asked: it searches NetEase
 *      deeply, scores every candidate against the title, the artist and
 *      the length, and only accepts a confident one.
 *
 * ## What is deliberately *not* here
 *
 * The third step reuses the existing matcher *as it is*. No scoring
 * rule is loosened, no threshold is lowered, and no candidate is
 * accepted on the strength of "it has comments under it". The matcher
 * decides which recording this is; this module only decides where to
 * ask.
 *
 * The reason is that a wrong match is much worse here than it is for
 * the heart sync. A wrong heart writes the wrong song into the user's
 * own library, which they can see and clean up. A wrong id here puts
 * *someone else's comments* under the track the user is reading — and
 * the comments look entirely plausible, so there is nothing to notice.
 */

/** How long a resolved id stays good. */
const ONE_HOUR = 60 * 60 * 1000;

/**
 * The NetEase song id a track already carries, without any lookup.
 *
 * This is the first step of the resolution and the one that covers
 * every track that came from NetEase in the first place.
 */
export function nativeNeteaseSongId(
  track: QueueTrack | undefined,
): string | undefined {
  if (!track) return undefined;
  if (track.provider === "netease") {
    return track.providerTrackId || undefined;
  }
  // The *discovery* origin counts too: a daily pick that was redirected
  // to YouTube still knows the NetEase record it came from, and that
  // record is the authoritative one.
  if (track.discoveredOn === "netease") {
    return track.discoveredTrackId || undefined;
  }
  return undefined;
}

/**
 * The NetEase song id for a track, resolved as far as it can be.
 *
 * The id the track carries is returned straight away. The registry is
 * consulted next, and the matcher only after that — so a track that
 * came from NetEase never pays for a search, and one the app already
 * knows about never pays for one either.
 *
 * The matcher runs in a query rather than in an effect, so a track that
 * changes cancels the lookup it started.
 */
export function useNeteaseSongId(track: QueueTrack | undefined): {
  /** The id, once it is known. */
  songId: string | undefined;
  /** Whether the lookup is still running. */
  isLoading: boolean;
  /**
   * Whether the id came from the matcher rather than from the track's
   * own fields.
   *
   * The UI shows this: a matched id is a *guess*, and the comments
   * under a guess are worth reading with that in mind.
   */
  isMatched: boolean;
} {
  const nativeId = nativeNeteaseSongId(track);

  // The registry is read through a subscription rather than a plain
  // lookup, so a mapping written *after* the track started playing
  // still turns the query on.
  const registrySongId = useNetEaseIdStore((s) =>
    track?.videoId ? s.byVideoId[track.videoId] : undefined,
  );

  const subject = subjectOf(track);
  const query = useQuery({
    queryKey: [
      "netease-song-id",
      subject.title,
      subject.artists.join(","),
      subject.duration ?? "",
    ],
    queryFn: async () => {
      const found = await findNeteaseSongId(subject);
      return found ?? undefined;
    },
    enabled: !!track && !nativeId && !registrySongId && !!subject.title,
    staleTime: ONE_HOUR,
    retry: false,
  });

  const songId = nativeId ?? registrySongId ?? query.data;
  return {
    songId,
    isLoading: query.isLoading,
    isMatched: !nativeId && !registrySongId && !!query.data,
  };
}
