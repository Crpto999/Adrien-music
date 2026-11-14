import { toast } from "sonner";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";
import { toQueueTrack } from "@/lib/providers/queue";
import { rememberPlatformPair } from "@/lib/store/netease-ids";
import { resolvePlaybackSource } from "@/lib/providers/playback";
import { getProviderOrder } from "@/lib/providers/order";
import { translate } from "@/lib/i18n";
import type { NeteaseSimilarSong } from "@/lib/netease/social";
import type { CanonicalTrack, ProviderId } from "@/lib/providers/types";

/**
 * Playing a song out of the encyclopedia.
 *
 * ## Why NetEase is the default
 *
 * The 百科's "喜欢这首歌的人也爱听" list is the platform's own answer
 * about which songs sound like this one, and every row carries the
 * catalogue's id for it. That id is *exact*: it is not a guess about
 * which recording the row means, it is the record. So NetEase is the
 * obvious first choice — it is the source of the list, and its id
 * needs no lookup at all.
 *
 * ## Why the other platforms still work
 *
 * NetEase will not serve every record to every account — a good part
 * of the catalogue sits behind a membership tier. So the row is not
 * bound to NetEase: the app's existing cross-provider machinery takes
 * over, and the other platforms are searched for the same recording
 * with the same scorer and the same rules the rest of the app uses.
 * The user can then switch sources by hand from the player's own
 * source switcher.
 *
 * The switch is never automatic: a wrong automatic switch plays the
 * wrong recording of the right song, and the user has no way to tell
 * except that it sounds wrong.
 */

/** The queue entry for a row of the similar-songs list. */
export function similarSongQueueTrack(
  song: NeteaseSimilarSong,
): QueueTrack {
  const duration = song.durationMs ? Math.round(song.durationMs / 1000) : undefined;
  return {
    ...toQueueTrack({
      provider: "netease",
      providerTrackId: song.id,
      title: song.title,
      artists: song.artists,
      album: song.album ?? undefined,
      duration,
      coverUrl: song.pictureUrl ?? undefined,
      aliases: song.aliases.length ? song.aliases : undefined,
    }),
    // Where the row was found, and the id the platform's own lyrics are
    // filed under. The two go together: without the id the origin would
    // be a name without an address.
    discoveredOn: "netease",
    discoveredTrackId: song.id,
  };
}

/**
 * The canonical form of a row, for the cross-provider matcher.
 *
 * The row's own NetEase id is the origin's id, and the origin's id is
 * authoritative — the matcher is not asked to rediscover what the
 * platform already said.
 */
export function similarSongCanonical(
  song: NeteaseSimilarSong,
): CanonicalTrack {
  return {
    title: song.title,
    artists: song.artists,
    album: song.album ?? undefined,
    duration: song.durationMs ? Math.round(song.durationMs / 1000) : undefined,
    // The row's own artwork. It is not part of the *matching* — the
    // matcher compares the title and the artist — but the canonical
    // form is what the queue entry is built from, and a track that
    // resolves to another provider's record would otherwise be left
    // with no artwork at all.
    coverUrl: song.pictureUrl ?? undefined,
    origin: "netease",
    originId: song.id,
  };
}

/**
 * Play a song from the encyclopedia's similar list.
 *
 * NetEase is tried first — the row is the platform's own record, and
 * its id needs no lookup. When NetEase will not serve it, the other
 * platforms are searched for the same recording, in the user's own
 * provider-priority order, with the same matcher the rest of the app
 * uses.
 *
 * Returns the source that will serve it, or `null` when nothing can
 * (in which case the NetEase entry is queued anyway and the stream
 * server's own fallback path gets its chance).
 */
export async function playSimilarSong(
  song: NeteaseSimilarSong,
): Promise<{ provider: ProviderId; providerTrackId: string } | null> {
  const base = similarSongQueueTrack(song);
  const canonical = similarSongCanonical(song);

  const source = await resolvePlaybackSource(canonical, {
    priority: getProviderOrder(),
  });

  if (!source) {
    // Nothing can serve it. The NetEase entry is still queued: the
    // stream server has its own fallback path, and a queued track it
    // can resolve is better than a click that does nothing.
    usePlaybackStore.getState().playNow(base);
    return null;
  }

  // The row and the record it resolved to are one recording under two
  // ids. Remembering that is what lets the track keep its NetEase
  // lyrics while it plays from the other platform, and what lets the
  // source switcher offer the row's *exact* NetEase record rather
  // than a search result that might be a cover.
  rememberPlatformPair(
    { provider: "netease", providerTrackId: song.id },
    { provider: source.provider, providerTrackId: source.providerTrackId },
  );

  usePlaybackStore.getState().playNow({
    ...base,
    ...toQueueTrack({
      provider: source.provider,
      providerTrackId: source.providerTrackId,
      title: song.title,
      artists: song.artists,
      album: song.album ?? undefined,
      duration: canonical.duration,
      // The artwork the canonical track carries. The source that won
      // is another platform's record, and its cover is not in hand
      // here — so the cover the user saw is kept. Without it the entry
      // has no artwork at all, and the player shows an empty square
      // and an empty backdrop for a track that plainly has a cover.
      coverUrl: canonical.coverUrl,
    }),
    discoveredOn: "netease",
    discoveredTrackId: song.id,
  });
  return source;
}

/**
 * Play a row, and report the outcome to the user.
 *
 * The toast is the difference between "it played" and "nothing
 * happened", which is what a click on a row that silently fails looks
 * like from the user's side.
 */
export async function playSimilarSongWithFeedback(
  song: NeteaseSimilarSong,
): Promise<void> {
  try {
    const source = await playSimilarSong(song);
    if (!source) {
      toast.error(
        translate("settings.providers.noPlayableSource", { title: song.title }),
      );
    }
  } catch (e) {
    toast.error(String(e));
  }
}
