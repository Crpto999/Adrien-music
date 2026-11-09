/**
 * The provider abstraction.
 *
 * A *provider* is a place a track can live: YouTube Music, NetEase
 * Cloud Music, Migu, Kugou, QQ Music, Spotify, Apple Music. Each one
 * has its own ids, its own catalogue and its own way of handing out a
 * stream URL — so the app needs a common shape for "this track, on that
 * provider".
 *
 * ## Why a reference and not a flag
 *
 * The music-video module is gone, so a track is no longer a YouTube
 * video id that might or might not have a video twin. A track is now
 * "a song", and where it can be *played from* is a separate question.
 * `ProviderRef` answers it: a provider plus that provider's own id for
 * the song.
 *
 * ## The identity problem
 *
 * The same song exists on several platforms with different ids, and
 * there is no key that joins them. The only thing they share is the
 * title and the artist — so finding the same recording elsewhere is a
 * *matching* problem, not a lookup. `scoreMatch` (./match.ts) is that
 * matcher; this module is the vocabulary around it.
 */

/** The providers the app can source audio from. */
export type ProviderId =
  | "youtube"
  | "netease"
  | "migu"
  | "kugou"
  | "qq"
  | "spotify"
  | "apple";

/**
 * A track's identity on one provider.
 *
 * `providerTrackId` is that platform's own id: a YouTube `videoId`, a
 * NetEase numeric song id, a QQ Music mid, and so on.
 */
export type ProviderRef = {
  provider: ProviderId;
  providerTrackId: string;
};

/**
 * A track as the app knows it, independent of any provider.
 *
 * This is what a cross-provider search matches against: the title and
 * artist are the only fields two platforms are guaranteed to agree on.
 */
export type CanonicalTrack = {
  title: string;
  artists: string[];
  album?: string;
  duration?: number;
  /** The provider this track was discovered on. */
  origin?: ProviderId;
  /** That provider's id for it. */
  originId?: string;
};

/** What a provider can do. */
export type ProviderCapabilities = {
  /** The provider can hand out a playable stream URL. */
  playable: boolean;
  /** The provider can return lyrics. */
  lyrics: boolean;
  /** The provider exposes a per-user catalogue (needs an account). */
  needsAccount: boolean;
  /**
   * The provider can resolve tracks the platform gates behind a paid
   * membership, given the user's own credentials.
   */
  canUnlockPaid: boolean;
};

/**
 * The order providers are tried in when a track has to be resolved to
 * something playable.
 *
 * YouTube is first because it is the app's native source: it needs no
 * account, its catalogue is the one the app already browses, and its
 * streams are the ones the disk cache and the player already handle.
 * The Chinese platforms follow because they carry the catalogue
 * YouTube misses — most notably the paid tracks, which YouTube simply
 * does not have.
 *
 * Spotify and Apple Music are deliberately absent: both gate their
 * audio behind DRM that cannot be played outside their own clients, so
 * they can serve metadata and search results but never a stream.
 */
export const PROVIDER_PRIORITY: ProviderId[] = [
  "youtube",
  "netease",
  "migu",
  "kugou",
  "qq",
];

/** The providers that can serve metadata but never audio. */
export const METADATA_ONLY_PROVIDERS: ProviderId[] = ["spotify", "apple"];

/** What each provider can do. */
export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  youtube: {
    playable: true,
    lyrics: true,
    needsAccount: false,
    canUnlockPaid: false,
  },
  netease: {
    playable: true,
    lyrics: true,
    needsAccount: false,
    canUnlockPaid: true,
  },
  migu: {
    playable: true,
    lyrics: true,
    needsAccount: false,
    canUnlockPaid: false,
  },
  kugou: {
    playable: true,
    lyrics: true,
    needsAccount: false,
    canUnlockPaid: false,
  },
  qq: {
    playable: true,
    lyrics: true,
    needsAccount: false,
    canUnlockPaid: true,
  },
  spotify: {
    playable: false,
    lyrics: false,
    needsAccount: true,
    canUnlockPaid: false,
  },
  apple: {
    playable: false,
    lyrics: false,
    needsAccount: true,
    canUnlockPaid: false,
  },
};

/** The provider's display name, in the app's own wording. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  youtube: "YouTube Music",
  netease: "NetEase Cloud Music",
  migu: "Migu Music",
  kugou: "Kugou Music",
  qq: "QQ Music",
  spotify: "Spotify",
  apple: "Apple Music",
};

/**
 * A candidate a provider returned for a cross-provider search.
 *
 * The fields are the intersection of what every provider exposes, so
 * the matcher never has to branch on the provider.
 */
export type ProviderCandidate = {
  provider: ProviderId;
  providerTrackId: string;
  title: string;
  artists: string[];
  album?: string;
  duration?: number;
  coverUrl?: string;
};

/**
 * A search result: the candidate plus how well it matched.
 */
export type ScoredCandidate = {
  candidate: ProviderCandidate;
  /** Higher is better. `null` means the candidate was rejected. */
  score: number | null;
};

/**
 * Build a canonical track from a candidate.
 *
 * Used to seed the matcher: the canonical track is what the user
 * picked on the platform they picked it on, and every other platform is
 * searched for it.
 */
export function toCanonical(candidate: ProviderCandidate): CanonicalTrack {
  return {
    title: candidate.title,
    artists: candidate.artists,
    album: candidate.album,
    duration: candidate.duration,
    origin: candidate.provider,
    originId: candidate.providerTrackId,
  };
}

/**
 * The providers to search for a track, in priority order.
 *
 * The origin provider is searched last (or not at all): the user
 * already has that result, and asking for it again wastes a round trip.
 */
export function searchOrderFor(
  origin: ProviderId,
  priority: ProviderId[] = PROVIDER_PRIORITY,
): ProviderId[] {
  return priority.filter((p) => p !== origin);
}

/**
 * The providers that can actually play audio, in priority order.
 */
export function playableProviders(
  priority: ProviderId[] = PROVIDER_PRIORITY,
): ProviderId[] {
  return priority.filter((p) => PROVIDER_CAPABILITIES[p].playable);
}

/** A stable string key for a provider reference. */
export function refKey(ref: ProviderRef): string {
  return `${ref.provider}:${ref.providerTrackId}`;
}

/** Parse a `provider:id` key back into a reference. */
export function parseRefKey(key: string): ProviderRef | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  const provider = key.slice(0, idx) as ProviderId;
  if (!(provider in PROVIDER_CAPABILITIES)) return null;
  return { provider, providerTrackId: key.slice(idx + 1) };
}
