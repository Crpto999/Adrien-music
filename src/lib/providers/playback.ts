import {
  PROVIDER_PRIORITY,
  type CanonicalTrack,
  type ProviderId,
  type ProviderRef,
} from "@/lib/providers/types";
import { getAvailability, rankAvailability } from "@/lib/providers/availability";
import { canPlayFrom, type PlayabilityProbe } from "@/lib/providers/probe";

/**
 * Choosing which provider will actually serve a track.
 *
 * The priority chain decides *order*, not *outcome*: a provider that
 * cannot produce a playable stream for a track is skipped and the next
 * one is tried. That distinction matters. "The platform gates this
 * track behind a membership" is not an error to be papered over — it
 * is information the user needs — so the chain tries the next source
 * and remembers which one won, but it never silently pretends the
 * gated provider served the track.
 *
 * This is a *pre-playback* source choice, not a mid-playback rescue:
 * it runs before a single byte of audio is heard, so swapping sources
 * here is "picked one that can play", not "saved the track after it
 * broke". A track that is already playing is never moved to another
 * provider behind the user's back.
 */

/** The outcome of picking a source for a track. */
export type PlaybackSource = {
  /** The provider that will serve the track. */
  provider: ProviderId;
  /** That provider's own id for the track. */
  providerTrackId: string;
  /** The other providers that have a match, for the source-switch UI. */
  alternatives: ProviderRef[];
  /**
   * The provider the track came from, when it differs from the one
   * that will serve it. This is the "discovered on NetEase, playing
   * from YouTube" case — worth showing, because the two are different
   * recordings of the same song and the user may want the other one.
   */
  discoveredOn?: ProviderId;
};

export type ResolvePlaybackOptions = {
  /** The order providers are tried in. */
  priority?: ProviderId[];
  signal?: AbortSignal;
  /** Overrides the built-in playability probes. */
  probe?: PlayabilityProbe;
};

/**
 * Pick the provider that will play this track.
 *
 * The algorithm:
 *
 *   1. Gather the candidates: every source that has the track, in the
 *      user's priority order. The search is concurrent — see
 *      `./availability` for why.
 *   2. Walk them in that order.
 *   3. The first one that can actually serve the track wins.
 *
 * Returns `null` when no provider can play the track — the caller
 * shows the error rather than substituting something arbitrary.
 */
export async function resolvePlaybackSource(
  canonical: CanonicalTrack,
  options?: ResolvePlaybackOptions,
): Promise<PlaybackSource | null> {
  const priority = options?.priority ?? PROVIDER_PRIORITY;

  // The candidates, in priority order. The availability search already
  // ranked them, so the order here is the user's order and not the
  // order the sources happened to answer in.
  const candidates = rankAvailability(
    new Map(
      (await getAvailability(canonical, { signal: options?.signal })).map(
        (ref) => [ref.provider, ref],
      ),
    ),
    canonical,
    priority,
  );

  for (const ref of candidates) {
    if (options?.signal?.aborted) return null;
    const providerProbe = options?.probe ?? canPlayFrom;
    // A provider with no probe is trusted: it either has a playable
    // catalogue or the stream server will say so.
    if (!providerProbe || (await providerProbe(ref, options?.signal))) {
      return {
        provider: ref.provider,
        providerTrackId: ref.providerTrackId,
        alternatives: candidates.filter((c) => c !== ref),
        discoveredOn:
          canonical.origin && canonical.origin !== ref.provider
            ? canonical.origin
            : undefined,
      };
    }
  }

  return null;
}

/**
 * The alternatives for a track, without picking one.
 *
 * The source-switch UI lists these; the user picks. Nothing is
 * auto-switched, because a wrong auto-switch is worse than no switch
 * at all (see the design note in `providers/match.ts`).
 *
 * The list is the *same* data the player used to choose a source — one
 * search, two readers — so the panel can never offer a source the
 * player never considered.
 */
export async function findAlternativeSources(
  canonical: CanonicalTrack,
  options?: { priority?: ProviderId[]; signal?: AbortSignal },
): Promise<ProviderRef[]> {
  const priority = options?.priority ?? PROVIDER_PRIORITY;
  const refs = await getAvailability(canonical, { signal: options?.signal });
  return rankAvailability(
    new Map(refs.map((ref) => [ref.provider, ref])),
    canonical,
    priority,
  );
}
