/**
 * Cross-provider track matching.
 *
 * The same song exists on several platforms under the same title and
 * artist, so finding "the same recording" on another provider needs a
 * judgement, not a string compare: a search for a popular song is full
 * of covers, live cuts and sped-up remixes that would silently play the
 * wrong audio.
 *
 * The scorer below is a generalisation of the one this app used for the
 * Song/Video switch, which had to solve the same problem inside
 * YouTube Music (pick the audio upload for a track that is also a
 * video, and the other way round).
 *
 * ## Chinese scripts
 *
 * The Chinese platforms write Simplified Chinese; a YouTube upload of
 * the same song may be Traditional. Both sides are converted to
 * Simplified before they are compared, so "愛你" and "爱你" are the
 * same title rather than two different ones. Without that, a
 * Taiwanese upload never matches the NetEase record that is sitting
 * right there in the catalogue.
 */

import { toSimplified } from "@/lib/chinese";

/** Words that say "this is the video/audio upload" rather than naming the song. */
const NOISE = new Set([
  "official",
  "video",
  "videoclip",
  "music",
  "audio",
  "lyrics",
  "lyric",
  "hd",
  "hq",
  "4k",
  "mv",
  "visualizer",
  "visualiser",
  "explicit",
  "clean",
  "remastered",
  "remaster",
  "version",
  "feat",
  "ft",
  "featuring",
  "with",
  "the",
  "a",
  "an",
  "and",
  "of",
  "topic",
  // Chinese noise: prefixes NetEase / Migu / QQ put on search results.
  "高音质",
  "超清",
  "无损",
  "完整版",
  "官方",
  "高品",
  "超品",
  "臻品",
  "全景声",
  "母带",
  "试听",
  "纯享",
  "伴奏",
  "消音",
]);

/** Tokens that mark a different recording; a candidate carrying one the
 *  original lacks is probably not the same song. */
const VARIANT = new Set([
  "remix",
  "cover",
  "live",
  "karaoke",
  "instrumental",
  "sped",
  "slowed",
  "reverb",
  "nightcore",
  "acoustic",
  "8d",
  "mashup",
  "edit",
  "reprise",
  // Chinese variant markers: NetEase mixes these into plain-title results.
  "翻唱",
  "现场",
  "钢琴",
  "纯音乐",
  "加速",
  "减速",
  "音效",
  "影视",
  "抖音",
  "卡点",
]);

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);

const significant = (s: string) => tokens(s).filter((t) => !NOISE.has(t));

/** What we know about the track we're looking for. */
export type MatchHint = {
  title: string;
  artists?: string[];
  /** Seconds, when known. */
  duration?: number;
};

/** A candidate from any provider, in the shape the scorer needs. */
export type MatchCandidate = {
  title: string;
  /** Provider-specific artist names. */
  artists?: string[];
  /** The artist line as a single string, when the provider has one. */
  artistLine?: string;
  /** Seconds, when known. */
  duration?: number;
};

/**
 * Judge one candidate against the track we're looking for. Returns null
 * when it is not convincingly the same recording, otherwise a ranking
 * score.
 *
 * Every gate must pass: a wrong track with right-sounding words in the
 * title is worse than no track at all, so near-misses are rejected
 * rather than ranked.
 */
export function scoreMatch(
  candidate: MatchCandidate,
  hint: MatchHint,
): number | null {
  // Both sides are compared in Simplified Chinese, so a Traditional
  // upload of a song matches the Simplified record of it.
  const wantTitle = toSimplified(hint.title);
  const gotTitle = toSimplified(candidate.title);
  const wantArtists = (hint.artists ?? []).map((a) => toSimplified(a));
  const gotArtists = (candidate.artists ?? []).map((a) => toSimplified(a));

  // 1. Title: nearly every meaningful word of the original must be
  //    there, and the candidate must not announce a different version.
  const want = significant(wantTitle);
  const got = new Set(significant(gotTitle));
  if (want.length === 0) return null;
  const coverage = want.filter((t) => got.has(t)).length / want.length;
  if (coverage < 0.75) return null;
  const wantSet = new Set(want);
  for (const t of got) {
    if (VARIANT.has(t) && !wantSet.has(t)) return null;
  }

  // 2. Artist.
  const names = wantArtists.filter(Boolean);
  let artistFrac = 0;
  if (names.length > 0) {
    const haystack = [
      gotTitle,
      toSimplified(candidate.artistLine ?? ""),
      ...gotArtists,
    ]
      .join(" ")
      .toLowerCase();
    artistFrac =
      names.filter((n) => haystack.includes(n.toLowerCase())).length /
      names.length;
  }
  const artistOk = artistFrac >= 0.5;

  // 3. Duration. Two platforms serve the same recording at nearly the
  //    same length; a real gap means a different take (a live cut, an
  //    edited radio version). The tolerance is deliberately tight —
  //    a music video may run long because of an intro, but an audio
  //    file that is 15% longer is a different recording.
  const d0 = hint.duration;
  const d1 = candidate.duration;
  const known = !!d0 && !!d1;
  const diff = known ? Math.abs(d0 - d1) : Infinity;
  const tol = Math.max(5, (d0 ?? 0) * 0.03);
  if (known && diff > tol) return null;

  // Title alone never decides: either the artist agrees, or the length
  // is all but identical.
  if (!artistOk && !(known && diff <= 5)) return null;

  let total = coverage * 3 + artistFrac * 2;
  total += known ? (diff <= 3 ? 2 : 1) : 0.3;
  return total;
}

/**
 * Whether the candidate's artist agrees with the track's.
 *
 * The scorer lets a candidate through on the strength of an almost
 * identical length alone, which is the right call when the question is
 * "can we play something close enough" — a cover is a fine substitute
 * for playback.
 *
 * It is the wrong call when the question is "is this *the* record the
 * user has in their library". A cover can share the original's exact
 * running time, so length alone cannot tell the two apart, and
 * hearting the cover would put the wrong recording into the user's
 * own collection.
 */
export function artistsAgree(
  candidate: MatchCandidate,
  hint: MatchHint,
): boolean {
  const names = (hint.artists ?? []).filter(Boolean).map((a) => toSimplified(a));
  if (names.length === 0) return true;
  const haystack = [
    toSimplified(candidate.title),
    toSimplified(candidate.artistLine ?? ""),
    ...(candidate.artists ?? []).map((a) => toSimplified(a)),
  ]
    .join(" ")
    .toLowerCase();
  const agreed = names.filter((n) => haystack.includes(n.toLowerCase())).length;
  return agreed / names.length >= 0.5;
}
