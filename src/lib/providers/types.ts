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
  /**
   * The artwork for the recording.
   *
   * Not part of the *matching* — the matcher compares the title and the
   * artist, and never the picture. It is here because the canonical
   * form is also what the queue entry is built from: a track that
   * resolves to another provider's record would otherwise be left with
   * no artwork at all, and the player shows an empty square and an
   * empty backdrop for a track that plainly has a cover.
   */
  coverUrl?: string;
  /** The provider this track was discovered on. */
  origin?: ProviderId;
  /** That provider's id for it. */
  originId?: string;
  /**
   * Ids the track is *known* by, per provider.
   *
   * An id listed here is authoritative: it is the exact record, not a
   * cross-platform match that might be a different recording (a cover,
   * a live cut). The origin's own id is authoritative by definition
   * and lives in `originId`; this map carries the *other* platforms'
   * ids, which the app established when it moved the track between
   * them.
   *
   * The case that matters is the NetEase daily pick the user hearts:
   * the pick is a NetEase recording, the heart puts it in the YouTube
   * liked list as a YouTube video id, and from then on the app knows
   * both ids of one recording. The YouTube id has to keep winning on
   * YouTube (the user hearted *that* video) and the NetEase id has to
   * be offered as the authoritative NetEase record — not a fuzzy
   * search result, which for a popular song can easily be a cover.
   */
  knownIds?: Partial<Record<ProviderId, string>>;
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
  /**
   * The platform's other names for the recording.
   *
   * NetEase files a song under an alias as well as its title, and the
   * alias is often the name the recording is known by *elsewhere* —
   * "晴天" is also "Sunny Day", and a Japanese release carries the
   * romanised title. Matching against the aliases is what connects a
   * YouTube upload filed under one name to the NetEase record filed
   * under another.
   */
  aliases?: string[];
  /**
   * Where the platform ranked this candidate, zero-based.
   *
   * The platform's own ordering is a strong prior — the authoritative
   * recording of a song sits at rank 0 in most searches — so the
   * matcher uses it as its last tie-breaker. `undefined` means the
   * candidate was not ranked.
   */
  rank?: number;
};

/**
 * A search result: the candidate plus how well it matched.
 */
export type ScoredCandidate = {
  candidate: ProviderCandidate;
  /**
   * The comparison key, or `null` when the candidate was rejected.
   *
   * The key is the cascade's tuple — the components in cascade order —
   * so it is compared lexicographically rather than summed. See
   * `docs/YouTube歌曲匹配算法.md` §7.
   */
  score: MatchKey | null;
  /**
   * How confident the matcher is that this is the same recording.
   *
   * The distinction matters for the *library* flows: a `high` or
   * `medium` match is good enough to write into the user's own
   * collection, a `low` one is only good enough to play. A `low` match
   * that came from the cover fallback is a different performer playing
   * the same song — serviceable as audio, wrong as a library entry.
   */
  confidence?: MatchConfidence;
};

/** How confident the matcher is in a match. */
export type MatchConfidence = "high" | "medium" | "low" | "failed";

/**
 * The comparison key the matcher produces.
 *
 * The components in cascade order — title, credit, artist, version,
 * duration, album, rank — compared as a tuple rather than summed.
 * See `docs/YouTube歌曲匹配算法.md` §7.
 */
export type MatchKey = readonly [
  number, // title
  number, // credit
  number, // artist
  number, // version
  number, // duration
  number, // album
  number, // rank
];

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
