import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  compareKeys,
  scoreCandidate,
  decideConfidence,
  artistsAgree,
  failureReason,
  type MatchKey,
} from "@/lib/providers/match";
import {
  logMatchReport,
  type MatchDebugCandidate,
} from "@/lib/providers/match/debug";
import { neteaseSearch } from "@/lib/providers/adapters/netease";
import { searchYouTube } from "@/lib/providers/adapters/youtube";
import { toSimplified } from "@/lib/chinese";
import { translate } from "@/lib/i18n";
import type { LastfmTrackMeta } from "@/lib/lastfm/track";
import type { QueueTrack } from "@/lib/store/playback";
import { rememberNeteaseSong } from "@/lib/store/netease-ids";
import type { ProviderId } from "@/lib/providers/types";

/**
 * Mirroring a heart to another platform.
 *
 * ## What the user asked for
 *
 * When the user hearts a track in the app, the app should also heart it
 * on NetEase — so the two libraries stay in step and the "我喜欢的音乐"
 * the user curated there is the same one here.
 *
 * ## The hard part: the ids are not interchangeable
 *
 * YouTube Music's track id is an 11-character opaque string; NetEase's
 * is a number. A NetEase id means nothing to YouTube, and a YouTube id
 * means nothing to NetEase. So the heart has to be *translated*: the
 * track is looked up in the other platform's catalogue, and only if the
 * two are convincingly the same recording is the heart mirrored.
 *
 * That "convincingly" is a threshold, and it has to be a real one.
 * Lighting the heart on the wrong song in the user's own library is
 * worse than not mirroring at all: the user would have to notice the
 * wrong track appearing in their NetEase collection and clean it up.
 * So a match below the threshold is not mirrored, and the user is told
 * why — which is also the honest answer to "the song isn't in my
 * NetEase library".
 *
 * ## The threshold
 *
 * The scorer's own scale is roughly 3 to 7: the title contributes up to
 * 3, the artist up to 2, and the length 0.3 to 2. A candidate that
 * passes every gate (the scorer rejects anything that does not) still
 * lands at 3.3 in the worst case — a title that matches, an artist
 * that does not, and an unknown length. That is exactly the candidate
 * we do not want to write into the user's library.
 *
 * 5.0 is the line: it demands that the artist agrees *and* the length
 * agrees, or that the recording is so close in length that the
 * different artist cannot mean a different recording.
 */

/**
 * The confidence a candidate must reach before the heart is written to
 * the user's NetEase library.
 *
 * Lighting the heart on the wrong song in the user's own library is
 * worse than not mirroring at all: the user would have to notice the
 * wrong track appearing in their NetEase collection and clean it up.
 *
 * So the bar is the doc's `high` or `medium` — the two stages the doc
 * says to "采用并缓存" (adopt and cache). The `low` stage is not
 * enough: the doc marks it "采用但标记需确认" (adopt, but flag for
 * confirmation), and a heart in the user's own library has no way to
 * ask for confirmation.
 */
export const LIKE_SYNC_CONFIDENCE = new Set(["high", "medium"]);

/** The track the heart was pressed on. */
export type LikeSyncTrack = {
  title: string;
  artists: string[];
  duration?: number;
};

/**
 * Find the NetEase record for a track, if there is a convincing one.
 *
 * Returns the song id, or `null` when NetEase does not have the track
 * or has only a doubtful match. `null` is a *normal* answer here: most
 * tracks in a YouTube-heavy library are simply not on NetEase.
 *
 * The lookup is cached, because the heart is pressed on the same
 * tracks repeatedly — and the second press (to un-heart) needs the
 * same answer the first one found.
 */
const matchCache = new Map<string, string | null>();

/** The cache key for a track. */
function cacheKey(track: LikeSyncTrack): string {
  return [
    toSimplified(track.title),
    track.artists.map((a) => toSimplified(a)).join(","),
    track.duration ?? "",
  ].join("|");
}

/**
 * The query to send to the other platform.
 *
 * The Chinese platforms' catalogues are written in Simplified Chinese,
 * so a Traditional title would find nothing there. YouTube's catalogue
 * has both, but sending Simplified there too keeps the two sides
 * comparable — the scorer compares in Simplified either way.
 */
function buildQuery(track: LikeSyncTrack): string {
  return [
    toSimplified(track.title),
    ...track.artists.map((a) => toSimplified(a)),
  ]
    .join(" ")
    .trim();
}

/**
 * The same decision, given an already-computed score.
 *
 * Split out so the diagnostics can see *every* candidate's score —
 * including the ones that were rejected — without scoring them
 * twice.
 */
function confidentScoreOf(
  scored: ReturnType<typeof scoreCandidate>,
  candidate: { title: string; artists: string[]; duration?: number },
  subject: LikeSyncTrack,
): MatchKey | null {
  // The cascade's confidence stages, decided on the components and the
  // comparison key together. A single candidate has no runner-up, so
  // the margin is waived — but the *stage* still has to be reached, and
  // the artist still has to agree.
  const confidence = decideConfidence(scored, null);
  if (!LIKE_SYNC_CONFIDENCE.has(confidence)) return null;
  // The scorer is lenient about the artist when the lengths match — a
  // cover is a fine substitute for *playback*. It is not fine for a
  // *library*: hearting a cover would put the wrong recording into the
  // user's own collection, so the artist has to agree here as well.
  if (
    !artistsAgree(candidate, {
      title: subject.title,
      artists: subject.artists,
      duration: subject.duration,
    })
  ) {
    return null;
  }
  return scored.key;
}

/**
 * Score every candidate, and record what happened.
 *
 * The rejected candidates are recorded too — a heart that was *not*
 * mirrored is exactly the case where the user needs to see why, and
 * "the search returned 100 rows and none of them looked like the
 * song" is the whole story.
 */
function scoreAndReport(
  provider: string,
  query: string,
  subject: LikeSyncTrack,
  rows: {
    id: string;
    title: string;
    artists: string[];
    duration?: number;
    album?: string | null;
    aliases?: string[];
  }[],
): Map<string, MatchKey> {
  const accepted = new Map<string, MatchKey>();
  const top: MatchDebugCandidate[] = [];

  for (const row of rows) {
    const scored = scoreCandidate(
      {
        title: row.title,
        artists: row.artists,
        duration: row.duration,
        album: row.album,
        aliases: row.aliases,
      },
      {
        title: subject.title,
        artists: subject.artists,
        duration: subject.duration,
      },
    );
    const confidence = decideConfidence(scored, null);
    const score = confidentScoreOf(scored, row, subject);
    if (score !== null) accepted.set(row.id, score);

    top.push({
      id: row.id,
      title: row.title,
      artists: row.artists,
      album: row.album,
      duration: row.duration,
      aliases: row.aliases,
      score: scored.key[0],
      t: scored.components.title,
      cr: scored.components.credit,
      a: scored.components.artist,
      v: scored.components.version,
      d: scored.components.duration,
      al: scored.components.album,
      rk: scored.components.rank,
      extraVersions: scored.extraVersions,
      confidence,
      reason:
        confidence === "failed"
          ? failureReason(scored, null)
          : score === null
            ? "below_like_sync_threshold"
            : undefined,
    });
  }

  top.sort((a, b) => b.t - a.t);

  const best = top[0];
  logMatchReport({
    provider,
    query,
    source: {
      title: subject.title,
      artists: subject.artists,
      duration: subject.duration,
    },
    candidateCount: rows.length,
    top: top.slice(0, 8),
    pickedId: best && accepted.has(best.id) ? best.id : undefined,
    confidence: best?.confidence,
    reason: accepted.size === 0 ? "no_confident_match" : undefined,
  });

  return accepted;
}

/**
 * Find the NetEase song id for a track.
 *
 * The search is sent in Simplified Chinese, because that is how
 * NetEase's catalogue is written: a Traditional title would find
 * nothing there.
 */
export async function findNeteaseSongId(
  track: LikeSyncTrack,
): Promise<string | null> {
  const key = cacheKey(track);
  const cached = matchCache.get(key);
  if (cached !== undefined) return cached;

  const title = toSimplified(track.title);
  const artists = track.artists.map((a) => toSimplified(a));
  const query = buildQuery(track);
  if (!query) {
    matchCache.set(key, null);
    return null;
  }

  let found: string | null = null;
  try {
    // The search asks for a deep page: the platform's ranking is not
    // "this song by this artist" — it puts other songs by the same
    // artist, and covers, above the one the user meant. The scorer
    // picks from the whole page.
    const songs = await neteaseSearch(query, 100);
    const accepted = scoreAndReport(
      "netease",
      query,
      { title, artists, duration: track.duration },
      songs.map((song) => ({
        id: song.id,
        title: song.title,
        artists: song.artists,
        duration: song.duration,
        album: song.album,
        aliases: song.aliases,
      })),
    );

    // The best match wins. The comparison key is a tuple, so the
    // winner is the one with the lexicographically greatest key.
    let bestId: string | null = null;
    let bestKey: MatchKey | null = null;
    for (const song of songs) {
      const key = accepted.get(song.id);
      if (key === undefined) continue;
      if (bestKey === null || compareKeys(key, bestKey) > 0) {
        bestKey = key;
        bestId = song.id;
      }
    }
    found = bestId;
  } catch (e) {
    // A search that fails is not a reason to fail the heart — the
    // YouTube heart is what the user asked for, and it has already
    // happened by the time this runs. The answer stays `null`, which
    // is also what "not in the NetEase catalogue" means.
    logMatchReport({
      provider: "netease",
      query,
      source: { title, artists, duration: track.duration },
      candidateCount: 0,
      top: [],
      reason: "search_failed",
      error: e instanceof Error ? e.message : String(e),
    });
  }

  matchCache.set(key, found);
  return found;
}

/**
 * Find the YouTube Music video id for a track.
 *
 * The mirror image of {@link findNeteaseSongId}: YouTube's ids are
 * opaque strings, so a NetEase track cannot be hearted on YouTube
 * until it has been looked up in YouTube's own catalogue and matched
 * with the same scorer and the same threshold.
 */
export async function findYouTubeVideoId(
  track: LikeSyncTrack,
): Promise<string | null> {
  const key = `yt|${cacheKey(track)}`;
  const cached = matchCache.get(key);
  if (cached !== undefined) return cached;

  const query = buildQuery(track);
  if (!query) {
    matchCache.set(key, null);
    return null;
  }

  let found: string | null = null;
  try {
    const candidates = await searchYouTube(query);
    const accepted = scoreAndReport(
      "youtube",
      query,
      {
        title: track.title,
        artists: track.artists,
        duration: track.duration,
      },
      candidates.map((candidate) => ({
        id: candidate.providerTrackId,
        title: candidate.title,
        artists: candidate.artists,
        duration: candidate.duration,
        album: candidate.album,
      })),
    );

    let bestId: string | null = null;
    let bestKey: MatchKey | null = null;
    for (const candidate of candidates) {
      const key = accepted.get(candidate.providerTrackId);
      if (key === undefined) continue;
      if (bestKey === null || compareKeys(key, bestKey) > 0) {
        bestKey = key;
        bestId = candidate.providerTrackId;
      }
    }
    found = bestId;
  } catch (e) {
    // Same as the NetEase side: a failed lookup is "no match".
    logMatchReport({
      provider: "youtube",
      query,
      source: {
        title: track.title,
        artists: track.artists,
        duration: track.duration,
      },
      candidateCount: 0,
      top: [],
      reason: "search_failed",
      error: e instanceof Error ? e.message : String(e),
    });
  }

  matchCache.set(key, found);
  return found;
}

/**
 * Forget the cached lookups.
 *
 * Used when the user signs out of NetEase — the answers are the
 * account's, so they go with it.
 */
export function clearLikeSyncCache(): void {
  matchCache.clear();
}

/**
 * Whether the user is signed in to NetEase.
 *
 * The heart is only mirrored when there is an account to mirror it to:
 * the platform's endpoint needs the account's id, and there is nothing
 * to sync to when nobody is signed in.
 */
let signedIn: boolean | null = null;

/** Record whether an account is signed in. */
export function setNeteaseLikeSyncAvailable(available: boolean): void {
  signedIn = available;
}

/**
 * The track's own platform id, when it has one.
 *
 * A track that came from NetEase already knows its NetEase song id —
 * there is nothing to look up. That is the common case for the daily
 * recommendation, and skipping the search is both faster and more
 * accurate than matching the track against NetEase's own catalogue to
 * arrive back where it started.
 *
 * The *discovery* origin counts too: a daily pick that was redirected
 * to YouTube still knows the NetEase record it came from, and that
 * record is the authoritative one — a fresh catalogue search could
 * land on a cover of the same song.
 */
function nativeId(
  track: QueueTrack | LastfmTrackMeta | undefined,
  provider: ProviderId,
): string | null {
  if (!track) return null;
  const candidate = track as Partial<QueueTrack>;
  if (candidate.provider === provider) {
    return candidate.providerTrackId ?? null;
  }
  if (candidate.discoveredOn === provider) {
    return candidate.discoveredTrackId ?? null;
  }
  return null;
}

/**
 * The track's subject: the title, the artists and the length, which
 * are the only fields two platforms are guaranteed to agree on.
 */
export function subjectOf(
  track: LikeSyncTrack | QueueTrack | LastfmTrackMeta | undefined,
): LikeSyncTrack {
  if (!track) return { title: "", artists: [] };
  return {
    title: track.title ?? "",
    artists: (track.artists ?? []).map((a) =>
      typeof a === "string" ? a : a.name,
    ),
    duration: "duration" in track ? track.duration : undefined,
  };
}

/**
 * Mirror a heart to NetEase.
 *
 * Called after the app's own heart has been toggled. It never throws:
 * the YouTube heart is the one the user pressed, and a failure to
 * mirror it is a footnote, not a failure of the action.
 *
 * Returns whether the heart was mirrored.
 */
export async function syncNeteaseLike(
  liked: boolean,
  track: LikeSyncTrack | QueueTrack | LastfmTrackMeta | undefined,
): Promise<boolean> {
  if (!track) return false;

  // No account: nothing to mirror to, and the user did not ask for a
  // NetEase prompt every time they heart a track.
  if (signedIn === false) return false;

  const subject = subjectOf(track);
  if (!subject.title.trim() || subject.artists.length === 0) return false;

  // A NetEase track already knows its NetEase id — no lookup needed.
  const songId =
    nativeId(track as QueueTrack, "netease") ??
    (await findNeteaseSongId(subject));
  if (!songId) {
    // The song is not in the user's NetEase library (or there is no
    // convincing match). Nothing to mirror, and the user should know
    // why rather than wonder.
    toast.info(translate("toast.neteaseLikeNoMatch", { title: subject.title }));
    return false;
  }

  try {
    await invoke("netease_set_like", { songId, like: liked });
    toast.success(
      translate(liked ? "toast.neteaseLiked" : "toast.neteaseUnliked"),
    );
    return true;
  } catch (e) {
    toast.error(
      translate("toast.neteaseLikeFailed", { detail: String(e) }),
    );
    return false;
  }
}

/**
 * Mirror a heart to YouTube Music.
 *
 * Called when the track the user hearted is *not* a YouTube track — a
 * NetEase daily pick, for instance. Its `videoId` is a synthetic
 * `netease_<id>` string that YouTube's like endpoint will not answer
 * to, so the track has to be looked up in YouTube's catalogue first
 * and matched with the same scorer and the same threshold.
 *
 * The lookup also establishes something worth keeping: the pick is one
 * recording under two ids, and from now on the app knows which
 * YouTube video holds which NetEase record. That is what lets the
 * track keep its NetEase lyrics when it plays from YouTube, and what
 * lets the source switcher offer the *exact* NetEase record rather
 * than a search result that might be a cover.
 *
 * Returns whether the heart was mirrored.
 */
export async function syncYouTubeLike(
  liked: boolean,
  track: LikeSyncTrack | QueueTrack | LastfmTrackMeta | undefined,
): Promise<boolean> {
  if (!track) return false;

  const subject = subjectOf(track);
  if (!subject.title.trim() || subject.artists.length === 0) return false;

  // A YouTube track already knows its YouTube id — no lookup needed.
  const videoId =
    nativeId(track as QueueTrack, "youtube") ??
    (await findYouTubeVideoId(subject));
  if (!videoId) {
    toast.info(
      translate("toast.youtubeLikeNoMatch", { title: subject.title }),
    );
    return false;
  }

  // The NetEase side of the same recording, when the track knows it.
  // Recorded before the heart is submitted, so the correspondence is
  // already there if the user plays the track a moment later.
  const neteaseSongId = nativeId(track as QueueTrack, "netease");
  if (neteaseSongId) {
    rememberNeteaseSong(videoId, neteaseSongId);
  }

  try {
    const { likeTrack, removeRating } = await import(
      "@/lib/innertube/mutations"
    );
    if (liked) {
      await likeTrack(videoId);
    } else {
      await removeRating(videoId);
    }
    toast.success(
      translate(liked ? "toast.youtubeLiked" : "toast.youtubeUnliked"),
    );
    return true;
  } catch (e) {
    toast.error(
      translate("toast.youtubeLikeFailed", { detail: String(e) }),
    );
    return false;
  }
}
