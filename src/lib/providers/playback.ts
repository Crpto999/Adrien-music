import { invoke } from "@tauri-apps/api/core";
import {
  PROVIDER_PRIORITY,
  playableProviders,
  searchOrderFor,
  type CanonicalTrack,
  type ProviderId,
  type ProviderRef,
} from "@/lib/providers/types";
import { findMatches } from "@/lib/providers/resolve";

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

/** What the backend says about a resolved NetEase track. */
type NeteaseResolved = {
  url: string;
  source: string;
  quality: string;
  size: number | null;
};

/**
 * Whether a provider can serve a track right now.
 *
 * A provider that cannot answer is not a failure of the app — it is
 * one link in the chain being skipped.
 */
export type PlayabilityProbe = (
  ref: ProviderRef,
  signal?: AbortSignal,
) => Promise<boolean>;

/**
 * Ask a provider whether it can play a specific track.
 *
 * This is the check the source switcher runs before it moves a track
 * to another provider: the matcher found a candidate there, but a
 * candidate is not a guarantee. NetEase in particular carries plenty
 * of tracks it will not serve without a membership, and the
 * third-party unblock pool exists for exactly those.
 */
export async function canPlayFrom(
  ref: ProviderRef,
  signal?: AbortSignal,
): Promise<boolean> {
  const probe = PROBES[ref.provider];
  // A provider with no probe is trusted: it either has a playable
  // catalogue or the stream server will say so.
  if (!probe) return true;
  try {
    return await probe(ref, signal);
  } catch {
    return false;
  }
}

/**
 * Whether the backend could resolve a track on one of the Chinese
 * platforms to a playable URL.
 *
 * `cn_resolve` is the same resolution the stream server performs, so
 * a `true` here means the track will actually play — not merely that
 * the platform lists it.
 */
async function probeCn(
  platform: "migu" | "kugou" | "qq",
  ref: ProviderRef,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    const resolved = await invoke<NeteaseResolved | null>("cn_resolve", {
      platform,
      songId: ref.providerTrackId,
    });
    if (signal?.aborted) return false;
    return !!resolved?.url;
  } catch {
    return false;
  }
}

/**
 * The default probes.
 *
 * YouTube needs no probe: its extractor can answer for essentially
 * every track the catalogue has, and probing it would double the
 * latency of every play for no information. NetEase does need one,
 * because its catalogue contains tracks the platform refuses to serve
 * without a membership — and those are exactly the tracks the
 * third-party unblock pool exists for.
 *
 * The Chinese platforms need one for the same reason: their free tiers
 * are large but their VIP tiers are not served to an anonymous client,
 * and the third-party resolver pool is what covers those.
 */
const PROBES: Partial<Record<ProviderId, PlayabilityProbe>> = {
  netease: async (ref, signal) => {
    if (signal?.aborted) return false;
    try {
      const resolved = await invoke<NeteaseResolved | null>(
        "netease_resolve",
        { songId: ref.providerTrackId },
      );
      if (signal?.aborted) return false;
      return !!resolved?.url;
    } catch {
      return false;
    }
  },
  migu: (ref, signal) => probeCn("migu", ref, signal),
  kugou: (ref, signal) => probeCn("kugou", ref, signal),
  qq: (ref, signal) => probeCn("qq", ref, signal),
};

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
 *   1. Collect the candidates: the track's own origin provider (its
 *      own id is authoritative — no matching needed) plus whatever the
 *      other providers match to.
 *   2. Walk them in priority order.
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
  const playable = playableProviders(priority);

  // The origin provider's own id is authoritative — the user picked
  // this track there, so it needs no matching.
  const originRef: ProviderRef | null =
    canonical.origin && canonical.originId
      ? { provider: canonical.origin, providerTrackId: canonical.originId }
      : null;

  // Search the other providers for the same recording.
  const matches = await findMatches(
    canonical,
    searchOrderFor(canonical.origin ?? "youtube", playable),
    options?.signal,
  );

  const candidates: ProviderRef[] = [];
  if (originRef) candidates.push(originRef);
  for (const provider of playable) {
    const m = matches.get(provider);
    if (m) candidates.push({ provider, providerTrackId: m.providerTrackId });
  }

  // Walk the chain in *priority* order, not discovery order: a track
  // found on NetEase still prefers YouTube when the user has not
  // changed the priority, because YouTube has no membership gate.
  const ordered = priority
    .map((p) => candidates.find((c) => c.provider === p))
    .filter((c): c is ProviderRef => c !== undefined);

  for (const ref of ordered) {
    if (options?.signal?.aborted) return null;
    const providerProbe = options?.probe ?? PROBES[ref.provider];
    // A provider with no probe is trusted: it either has a playable
    // catalogue or the stream server will say so.
    if (!providerProbe || (await providerProbe(ref, options?.signal))) {
      return {
        provider: ref.provider,
        providerTrackId: ref.providerTrackId,
        alternatives: ordered.filter((c) => c !== ref),
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
 */
export async function findAlternativeSources(
  canonical: CanonicalTrack,
  options?: { priority?: ProviderId[]; signal?: AbortSignal },
): Promise<ProviderRef[]> {
  const priority = options?.priority ?? PROVIDER_PRIORITY;
  const playable = playableProviders(priority);
  const matches = await findMatches(
    canonical,
    searchOrderFor(canonical.origin ?? "youtube", playable),
    options?.signal,
  );
  const out: ProviderRef[] = [];
  if (canonical.origin && canonical.originId) {
    out.push({
      provider: canonical.origin,
      providerTrackId: canonical.originId,
    });
  }
  for (const provider of playable) {
    const m = matches.get(provider);
    if (m) out.push({ provider, providerTrackId: m.providerTrackId });
  }
  return out;
}
