import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { scoreMatch, artistsAgree } from "@/lib/providers/match";
import { neteaseSearch } from "@/lib/providers/adapters/netease";
import { searchYouTube } from "@/lib/providers/adapters/youtube";
import { toSimplified } from "@/lib/chinese";
import { translate } from "@/lib/i18n";
import type { LastfmTrackMeta } from "@/lib/lastfm/track";
import type { QueueTrack } from "@/lib/store/playback";
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
 * The score a candidate must reach before the heart is mirrored to it.
 *
 * See the module comment for how the scorer's scale maps onto this.
 */
export const LIKE_SYNC_THRESHOLD = 5;

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
 * Score a candidate against the track, and say how good the match is.
 *
 * Returns `null` when the candidate is not a confident enough match to
 * write into the user's own library.
 */
function confidentScore(
  candidate: { title: string; artists: string[]; duration?: number },
  subject: LikeSyncTrack,
): number | null {
  const score = scoreMatch(candidate, {
    title: subject.title,
    artists: subject.artists,
    duration: subject.duration,
  });
  if (score === null || score < LIKE_SYNC_THRESHOLD) return null;
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
  return score;
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
    const scored = songs
      .map((song) => ({
        song,
        score: confidentScore(
          {
            title: song.title,
            artists: song.artists,
            duration: song.duration,
          },
          { title, artists, duration: track.duration },
        ),
      }))
      .filter((row): row is { song: (typeof songs)[number]; score: number } =>
        row.score !== null,
      )
      // The best match wins; ties go to the shorter difference, which
      // the scorer already accounts for in its total.
      .sort((a, b) => b.score - a.score);

    found = scored[0]?.song.id ?? null;
  } catch {
    // A search that fails is not a reason to fail the heart — the
    // YouTube heart is what the user asked for, and it has already
    // happened by the time this runs. The answer stays `null`, which
    // is also what "not in the NetEase catalogue" means.
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
    const scored = candidates
      .map((candidate) => ({
        candidate,
        score: confidentScore(
          {
            title: candidate.title,
            artists: candidate.artists,
            duration: candidate.duration,
          },
          { title: track.title, artists: track.artists, duration: track.duration },
        ),
      }))
      .filter(
        (row): row is { candidate: (typeof candidates)[number]; score: number } =>
          row.score !== null,
      )
      .sort((a, b) => b.score - a.score);

    found = scored[0]?.candidate.providerTrackId ?? null;
  } catch {
    // Same as the NetEase side: a failed lookup is "no match".
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
 */
function nativeId(
  track: QueueTrack | LastfmTrackMeta | undefined,
  provider: ProviderId,
): string | null {
  if (!track) return null;
  const candidate = track as Partial<QueueTrack>;
  if (candidate.provider !== provider) return null;
  return candidate.providerTrackId ?? null;
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
