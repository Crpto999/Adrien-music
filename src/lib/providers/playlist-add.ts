import { addManyToPlaylist } from "@/lib/innertube/mutations";
import type { ShelfItem } from "@/lib/innertube/types";
import { findYouTubeVideoId, subjectOf } from "@/lib/providers/netease-like";
import {
  neteaseVideoForSong,
  rememberNeteaseSong,
} from "@/lib/store/netease-ids";
import type { QueueTrack } from "@/lib/store/playback";

/**
 * Adding tracks to a YouTube playlist.
 *
 * ## The id problem
 *
 * A YouTube playlist stores YouTube `videoId`s and nothing else. A
 * NetEase daily pick carries a NetEase song id — a number — and that
 * number means nothing to YouTube's `browse/edit_playlist` endpoint.
 *
 * So a pick that is added to a playlist has to be *translated* first:
 * the same recording is looked up in YouTube's own catalogue and
 * matched with the scorer (see `./netease-like`), and it is the
 * matched video that goes into the playlist.
 *
 * ## The id that is worth keeping
 *
 * The translation is also the moment the app learns something worth
 * keeping: the pick and the video are one recording under two ids.
 * That correspondence is recorded, so the track can come back out of
 * the playlist and still be recognised as the NetEase recording it
 * came from — with NetEase's own lyrics, and with the switcher
 * offering the *exact* NetEase record rather than a search result
 * that might be a cover.
 */

/** A row, in the two shapes the playlist flows pass them around in. */
type AddableTrack = ShelfItem | QueueTrack;

/** The NetEase song id a row names, when it names one. */
function neteaseSongIdOf(track: AddableTrack): string | undefined {
  const candidate = track as Partial<QueueTrack>;
  if (candidate.provider === "netease") return candidate.providerTrackId;
  if (candidate.discoveredOn === "netease") return candidate.discoveredTrackId;
  return undefined;
}

/** The YouTube video id a row names, when it names one. */
function youtubeVideoIdOf(track: AddableTrack): string | undefined {
  const candidate = track as Partial<QueueTrack>;
  if (candidate.provider && candidate.provider !== "youtube") return undefined;
  if (candidate.provider === "youtube") {
    return candidate.providerTrackId ?? candidate.videoId;
  }
  // A row with no provider is a YouTube row (the app's convention), and
  // its id is in `id` for a shelf row and `videoId` for a queue entry.
  return candidate.videoId ?? (track as ShelfItem).id;
}

/**
 * The YouTube video id for a row, translating a NetEase row if needed.
 *
 * Returns `undefined` when the row cannot be placed on a YouTube
 * playlist — either because it has no YouTube counterpart, or because
 * the counterpart could not be found with enough confidence.
 */
export async function youtubeIdForPlaylist(
  track: AddableTrack,
): Promise<string | undefined> {
  // A YouTube row already knows its own id.
  const own = youtubeVideoIdOf(track);
  if (own) return own;

  // A NetEase row: the counterpart may already be known from a
  // previous translation, which is both free and exact.
  const songId = neteaseSongIdOf(track);
  if (!songId) return undefined;

  const known = neteaseVideoForSong(songId);
  if (known) return known;

  // Otherwise the recording has to be looked up in YouTube's catalogue
  // and matched. The matcher is conservative on purpose: a wrong video
  // in the user's playlist is worse than a track that did not make it
  // in.
  const candidate = track as Partial<QueueTrack>;
  const subject = subjectOf({
    title: candidate.title ?? "",
    artists: (candidate.artists ?? []).map((a) =>
      typeof a === "string" ? a : a.name,
    ),
    duration: candidate.duration,
  });
  const videoId = await findYouTubeVideoId(subject);
  if (!videoId) return undefined;

  // The translation is the moment the correspondence is established.
  rememberNeteaseSong(videoId, songId);
  return videoId;
}

/**
 * Add rows to a YouTube playlist.
 *
 * Rows that cannot be placed — a NetEase pick with no YouTube
 * counterpart, say — are skipped rather than failing the whole batch,
 * so one unmatchable track does not cost the user the rest of their
 * selection.
 *
 * Returns the ids that were actually added.
 */
export async function addTracksToPlaylist(
  playlistId: string,
  tracks: AddableTrack[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const track of tracks) {
    const videoId = await youtubeIdForPlaylist(track);
    if (!videoId) continue;
    ids.push(videoId);
    // A NetEase row that went in under its YouTube id leaves the
    // correspondence behind, so it can be recognised when it comes
    // back out.
    const songId = neteaseSongIdOf(track);
    if (songId) rememberNeteaseSong(videoId, songId);
  }
  if (ids.length === 0) {
    throw new Error("noTrackCouldBeAdded");
  }
  await addManyToPlaylist(playlistId, ids);
  return ids;
}
