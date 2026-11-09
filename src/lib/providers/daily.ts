import { useEffect, useRef } from "react";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";
import { toQueueTrack } from "@/lib/providers/queue";
import { canPlayFrom } from "@/lib/providers/playback";
import { findMatches } from "@/lib/providers/resolve";
import { getProviderOrder } from "@/lib/providers/play";
import { toCandidate, type NeteaseSong } from "@/lib/providers/adapters/netease";
import {
  playableProviders,
  searchOrderFor,
  type CanonicalTrack,
  type ProviderRef,
} from "@/lib/providers/types";

/**
 * Turning the NetEase daily picks into a playable queue.
 *
 * ## The picks are discoveries, not playback sources
 *
 * A daily pick is the platform saying "this record suits you". Whether
 * it can *actually be played* is a different question, and for a good
 * share of the catalogue the answer is "not from NetEase": a large
 * part sits behind a membership tier the account does not have, and a
 * few records are simply absent from the platform's own CDN.
 *
 * So each pick is resolved like this:
 *
 *   1. **Can NetEase serve it?** One probe answers this — the same
 *      resolution the stream server runs before serving the bytes. When
 *      the answer is yes (the common case) the track plays straight
 *      from NetEase and no cross-provider search happens at all.
 *   2. **When it cannot**, the other platforms are searched for the
 *      same recording and the first one that can serve it wins, in the
 *      user's own provider-priority order.
 *
 * NetEase is tried first on purpose. The picks came from NetEase, so
 * that recording is the one the user is being offered — the other
 * platforms are substitutes for the ones NetEase will not serve, not
 * better versions of it.
 *
 * ## Why the resolution is not eager
 *
 * Resolving against every other platform means several parallel
 * searches per track. Doing that for a whole playlist up front would
 * fire a hundred requests before the user pressed play, most of them
 * for tracks nobody was going to hear.
 *
 * So the queue is built from NetEase-origin entries and the
 * resolution happens in two places:
 *
 *   - The track the user clicks is resolved before it starts, so it is
 *     always served by a source that can actually play it.
 *   - The tracks just ahead of it are resolved in the background and
 *     their queue slots are upgraded in place (`setTrackProvider`)
 *     once the answer lands. The playing slot is never re-pointed
 *     while it is playing — that would re-resolve its stream
 *     mid-song.
 */

/** How many tracks ahead of the current one get resolved in advance. */
const LOOKAHEAD = 2;

/**
 * The resolution cache, keyed by the NetEase song id.
 *
 * Shared between the click handler and the lookahead hook, so a track
 * that was resolved before the user reached it is not resolved twice.
 * A `null` entry is a real answer ("nothing can serve this"), so it
 * is cached rather than re-probed.
 */
const resolutionCache = new Map<string, ProviderRef | null>();

/** The resolutions currently in flight, so two callers don't double up. */
const inFlight = new Map<string, Promise<ProviderRef | null>>();

/**
 * The queue entries for a list of daily picks.
 *
 * Each entry is a NetEase-origin track: `provider: "netease"` with the
 * platform's own song id, and a synthetic `videoId` so it can never
 * collide with a YouTube id. The audio engine streams it through
 * NetEase's route, and the Rust side falls back to its third-party
 * resolver pool for the titles the platform gates.
 */
export function dailyQueueTracks(songs: NeteaseSong[]): QueueTrack[] {
  return songs.map((song) => ({
    ...toQueueTrack(toCandidate(song)),
    // Remember where the track was discovered, so the player can say
    // "found on NetEase, playing from YouTube" once the slot is
    // upgraded to another provider.
    discoveredOn: "netease",
  }));
}

/** The canonical form of a pick, for the cross-provider matcher. */
function canonicalFor(song: NeteaseSong): CanonicalTrack {
  return {
    title: song.title,
    artists: song.artists,
    album: song.album ?? undefined,
    duration: song.duration,
    origin: "netease",
    originId: song.id,
  };
}

/**
 * The provider that should serve a pick.
 *
 * NetEase wins when it can play the track. When it cannot, the other
 * platforms are searched for the same recording and the first one that
 * *can* serve it wins, in the user's provider-priority order.
 *
 * `null` means nothing could serve it — the caller then leaves the
 * track on NetEase and lets the stream server try its own fallbacks.
 */
export async function resolveDailySource(
  song: NeteaseSong,
): Promise<ProviderRef | null> {
  const cached = resolutionCache.get(song.id);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(song.id);
  if (pending) return pending;

  const promise = resolveUncached(song).then((ref) => {
    resolutionCache.set(song.id, ref);
    inFlight.delete(song.id);
    return ref;
  });
  inFlight.set(song.id, promise);
  return promise;
}

/** The resolution itself, without the cache in front of it. */
async function resolveUncached(
  song: NeteaseSong,
): Promise<ProviderRef | null> {
  const neteaseRef: ProviderRef = {
    provider: "netease",
    providerTrackId: song.id,
  };

  // The cheap question first: one request answers it, and a "yes"
  // saves several parallel searches.
  if (await canPlayFrom(neteaseRef)) return neteaseRef;

  // NetEase cannot serve it, so look elsewhere. The origin provider is
  // excluded from the search — we already know its answer.
  const priority = getProviderOrder();
  const playable = playableProviders(priority);
  const searchable = searchOrderFor("netease", playable);
  if (searchable.length === 0) return null;

  const matches = await findMatches(canonicalFor(song), searchable);
  for (const provider of searchable) {
    const match = matches.get(provider);
    if (!match) continue;
    const ref: ProviderRef = {
      provider,
      providerTrackId: match.providerTrackId,
    };
    if (await canPlayFrom(ref)) return ref;
  }

  return null;
}

/**
 * The queue entry for a pick, pointed at its best available source.
 *
 * Falls back to the plain NetEase entry when the chain finds nothing,
 * so the track still gets a chance through the stream server's own
 * fallback path.
 */
export async function resolvedDailyTrack(
  song: NeteaseSong,
): Promise<QueueTrack> {
  const base = dailyQueueTracks([song])[0];
  const ref = await resolveDailySource(song);
  if (!ref || ref.provider === "netease") return base;
  return {
    ...base,
    ...toQueueTrack({
      provider: ref.provider,
      providerTrackId: ref.providerTrackId,
      title: song.title,
      artists: song.artists,
      album: song.album ?? undefined,
      duration: song.duration,
    }),
    // The pick is being served by another provider, but the NetEase
    // song id is still the key its own lyrics are filed under.
    discoveredOn: "netease",
    discoveredTrackId: song.id,
  };
}

/**
 * Keep the queue's picks pointed at their best source.
 *
 * The hook watches the queue and resolves the picks that are about to
 * play:
 *
 *   - The slot the user just started is resolved right away, so a pick
 *     NetEase will not serve is redirected before the backend's own
 *     resolution gives up on it.
 *   - The slots just ahead of it are resolved in the background and
 *     upgraded in place, so the next pick is already pointing at the
 *     right provider by the time the user reaches it.
 *
 * A slot that is *audible* is never re-pointed: the switch would
 * re-resolve its stream mid-song. A slot that is still loading — or
 * that has just failed — can be switched freely, because nothing is
 * playing yet and the audio engine re-resolves the stream as soon as
 * the provider changes.
 */
export function useDailySourceUpgrade(songs: NeteaseSong[]): void {
  const index = usePlaybackStore((s) => s.index);
  const queue = usePlaybackStore((s) => s.queue);
  const status = usePlaybackStore((s) => s.status);

  // The picks, keyed by their NetEase song id. Only the entries the
  // queue holds as NetEase-origin tracks are candidates for an
  // upgrade — a slot that already plays from another provider is done.
  const byId = useRef(new Map<string, NeteaseSong>());
  byId.current = new Map(songs.map((s) => [s.id, s]));

  useEffect(() => {
    if (index < 0) return;

    // The playing slot is only fair game while it is not making noise
    // yet; once it is playing, switching it would cut the track off
    // mid-song.
    const canSwitchCurrent = status !== "ready";
    const first = canSwitchCurrent ? index : index + 1;
    const last = Math.min(index + LOOKAHEAD, queue.length - 1);

    for (let i = first; i <= last; i++) {
      const track = i < queue.length ? queue[i] : undefined;
      if (!track || track.provider !== "netease") continue;
      const songId = track.providerTrackId;
      if (!songId) continue;

      const cached = resolutionCache.get(songId);
      if (cached === undefined) {
        // Not resolved yet — kick off a resolution, unless one is
        // already in flight for this track.
        const song = byId.current.get(songId);
        if (!song) continue;
        void resolveDailySource(song).then((ref) => {
          if (!ref || ref.provider === "netease") return;
          // The queue may have changed while the resolution was in
          // flight — re-read it and only upgrade a slot that still
          // holds this NetEase track and is not audibly playing.
          const state = usePlaybackStore.getState();
          for (let s = 0; s < state.queue.length; s++) {
            if (s === state.index && state.status === "ready") continue;
            const t = state.queue[s];
            if (t.provider !== "netease") continue;
            if (t.providerTrackId !== songId) continue;
            state.setTrackProvider(s, ref);
          }
        });
        continue;
      }
      if (!cached || cached.provider === "netease") continue;
      upgradeSlot(i, cached);
    }
  }, [index, queue, status]);
}

/**
 * Point a queue slot at another provider.
 *
 * A no-op when the slot has already moved on — the queue is re-read
 * at the moment of the change, because a slot's index is not stable
 * across a reorder.
 */
function upgradeSlot(slot: number, ref: ProviderRef): void {
  const state = usePlaybackStore.getState();
  if (slot < 0 || slot >= state.queue.length) return;
  if (state.index === slot && state.status === "ready") return;
  const track = state.queue[slot];
  if (!track || track.provider !== "netease") return;
  state.setTrackProvider(slot, ref);
}

/**
 * Forget the cached resolutions.
 *
 * Used when the user signs out of NetEase — the picks are the
 * account's, so the answers are the account's too.
 */
export function clearDailyResolutions(): void {
  resolutionCache.clear();
  inFlight.clear();
}
