import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchLrclibLyrics } from "@/lib/lyrics/lrclib";
import { fetchMusixmatchLyrics } from "@/lib/lyrics/musixmatch";
import { fetchGeniusLyrics } from "@/lib/lyrics/genius";
import { fetchYtMusicLyrics } from "@/lib/lyrics/ytmusic";
import { fetchCnLyrics } from "@/lib/lyrics/cn";
import { fetchNeteaseLyrics } from "@/lib/lyrics/netease";
import { shouldRetryLyricsQuery } from "@/lib/lyrics/http";
import { cleanTrackTitle, lyricsArtist } from "@/lib/track-meta";
import { toSimplified } from "@/lib/chinese";
import type { Lyrics } from "@/lib/lyrics/types";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";

export type LyricsSource =
  | "ytmusic"
  | "netease"
  | "migu"
  | "kugou"
  | "qq"
  | "lrclib"
  | "musixmatch"
  | "genius";

/**
 * Preference order. YouTube Music leads because it is the only source
 * matched by videoId rather than by text, so it cannot return a different
 * song. The Chinese platforms follow for the same reason — they are
 * keyed on the platform's own track id — and they are asked first among
 * the id-keyed sources because a Chinese track's words are far more
 * likely to be right on a Chinese platform than on a text-matching one.
 * The rest follow as fallbacks for the tracks they have nothing for.
 */
export const SOURCE_ORDER: LyricsSource[] = [
  "ytmusic",
  "netease",
  "migu",
  "kugou",
  "qq",
  "lrclib",
  "musixmatch",
  "genius",
];

export const SOURCE_LABELS: Record<LyricsSource, string> = {
  ytmusic: "YouTube Music",
  netease: "NetEase Cloud Music",
  migu: "Migu Music",
  kugou: "Kugou Music",
  qq: "QQ Music",
  lrclib: "LRCLIB",
  musixmatch: "Musixmatch",
  genius: "Genius",
};

const ONE_HOUR = 60 * 60 * 1000;

/**
 * Bumped whenever the query we send changes shape. Lyrics are persisted to
 * IndexedDB for 24h (`query-client.ts:9`, `App.tsx:49`), so without this a
 * user keeps yesterday's answer, looked up with yesterday's broken title
 * and artist, for a day after installing the fix.
 */
const LOOKUP_VERSION = "v3";

/**
 * Fire both lyric queries in parallel, plus a derived "best" selection.
 * Auto-pick rule: first source (in `SOURCE_ORDER`) that has any lyrics,
 * with timed lyrics ALWAYS winning over plain — i.e. if LRCLIB has plain
 * text but Musixmatch has synced LRC, Musixmatch wins.
 */
export function useLyricsSources(track: QueueTrack | undefined, enabled: boolean) {
  // YTM's display strings are not lookup strings. See track-meta.ts for the
  // measurements; in short, the raw title and the raw subtitle each cost
  // most or all of the LRCLIB result set.
  //
  // Memoised because both player bars call this hook and re-render on every
  // position tick, while the answer only changes when the track does. The
  // work is small either way; this just keeps it off the hot path.
  const artistName = useMemo(() => lyricsArtist(track), [track]);
  const trackTitle = useMemo(
    () => (track ? cleanTrackTitle(track.title) : undefined),
    [track],
  );

  // The lookup strings are sent in Simplified Chinese.
  //
  // The lyrics databases are indexed the way the platforms' catalogues
  // are written — mostly Simplified, some Traditional — so a
  // Traditional title has to be searched for in Simplified to find
  // anything. The *displayed* lyrics are converted the other way in
  // each source's own fetcher, so what the user reads is always
  // Simplified regardless of which database answered.
  const lookupTitle = useMemo(
    () => (trackTitle ? toSimplified(trackTitle) : undefined),
    [trackTitle],
  );
  const lookupArtist = useMemo(
    () => (artistName ? toSimplified(artistName) : undefined),
    [artistName],
  );

  // The real duration, once the audio element knows it. Used only when the
  // browse response had none, which is the case the old code got wrong:
  // with no duration LRCLIB's search picks blind from records that can be
  // minutes apart. Preferring the browse value when present keeps the query
  // key stable, so the common track costs one round rather than a second
  // one when playback resolves.
  const liveDuration = usePlaybackStore((s) => s.duration);
  const duration =
    track?.duration ?? (liveDuration > 0 ? liveDuration : undefined);

  // One automatic retry, and none at all when the provider said we are
  // asking too often.
  //
  // The cap stays at 1 because each provider now has its own 8 s deadline
  // (see http.ts), so attempts are bounded but still add up, and the only
  // time the user waits out a full chain is when every source is failing,
  // which is exactly when there is nothing to show anyway.
  //
  // The rate-limit exemption matters more. These queries run on every track
  // change whether or not the panel is open, and Musixmatch gates at
  // roughly 20 requests per IP per two minutes. Retrying a refusal doubles
  // the pressure on the one provider that is already saying stop, and would
  // turn a brief gate into a lasting one. Those get the Try again button
  // instead, which is a human deciding enough time has passed.
  // Keyed on the videoId alone: no title, no artist, nothing fuzzy. This
  // is the query that structurally cannot come back with another song.
  const ytmusic = useQuery({
    queryKey: ["lyrics", "ytmusic", LOOKUP_VERSION, track?.videoId],
    queryFn: ({ signal }) => fetchYtMusicLyrics(track?.videoId, signal),
    enabled: !!track?.videoId && enabled,
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  // The Chinese platforms answer about *their own* track id, so a query
  // only makes sense for a track that actually came from one of them.
  // A track playing from YouTube has no Migu id to ask about.
  const cnProvider = track?.provider;
  const cnTrackId = track?.providerTrackId;
  const cnEnabled =
    !!track &&
    enabled &&
    (cnProvider === "migu" || cnProvider === "kugou" || cnProvider === "qq") &&
    !!cnTrackId;

  // NetEase's own lyrics, keyed on the platform's song id. This is the
  // source that matters for the daily recommendation: those picks are
  // NetEase records, so the platform has exactly the right words for
  // them.
  //
  // A pick that NetEase will not serve is redirected to another
  // provider, and the NetEase id survives the redirection in
  // `discoveredTrackId` — the words did not change with the audio
  // source, so the lyrics must not change either.
  const neteaseSongId =
    track?.provider === "netease"
      ? track.providerTrackId
      : track?.discoveredOn === "netease"
        ? track.discoveredTrackId
        : undefined;
  const netease = useQuery({
    queryKey: ["lyrics", "netease", LOOKUP_VERSION, neteaseSongId],
    queryFn: ({ signal }) => fetchNeteaseLyrics(neteaseSongId, signal),
    enabled: !!track && enabled && !!neteaseSongId,
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  const lrclib = useQuery({
    queryKey: [
      "lyrics",
      "lrclib",
      LOOKUP_VERSION,
      lookupTitle,
      lookupArtist,
      track?.album,
      duration,
    ],
    queryFn: ({ signal }) =>
      fetchLrclibLyrics(
        {
          title: lookupTitle!,
          artist: lookupArtist!,
          album: track?.album,
          duration,
        },
        signal,
      ),
    enabled: !!track && enabled,
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  const musixmatch = useQuery({
    queryKey: [
      "lyrics",
      "musixmatch",
      LOOKUP_VERSION,
      lookupTitle,
      lookupArtist,
    ],
    queryFn: ({ signal }) =>
      fetchMusixmatchLyrics(
        {
          title: lookupTitle!,
          artist: lookupArtist!,
        },
        signal,
      ),
    enabled: !!track && enabled,
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  const genius = useQuery({
    queryKey: [
      "lyrics",
      "genius",
      LOOKUP_VERSION,
      lookupTitle,
      lookupArtist,
    ],
    queryFn: ({ signal }) =>
      fetchGeniusLyrics(
        {
          title: lookupTitle!,
          artist: lookupArtist!,
        },
        signal,
      ),
    enabled: !!track && enabled,
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  // The Chinese platforms answer about *their own* track id, so a query
  // only makes sense for a track that actually came from one of them.
  // A track playing from YouTube has no Migu id to ask about.
  const migu = useQuery({
    queryKey: ["lyrics", "migu", LOOKUP_VERSION, cnTrackId],
    queryFn: ({ signal }) => fetchCnLyrics("migu", cnTrackId, signal),
    enabled: cnEnabled && cnProvider === "migu",
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  const kugou = useQuery({
    queryKey: ["lyrics", "kugou", LOOKUP_VERSION, cnTrackId],
    queryFn: ({ signal }) => fetchCnLyrics("kugou", cnTrackId, signal),
    enabled: cnEnabled && cnProvider === "kugou",
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  const qq = useQuery({
    queryKey: ["lyrics", "qq", LOOKUP_VERSION, cnTrackId],
    queryFn: ({ signal }) => fetchCnLyrics("qq", cnTrackId, signal),
    enabled: cnEnabled && cnProvider === "qq",
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  const queries: Record<LyricsSource, UseQueryResult<Lyrics | null>> = {
    ytmusic,
    netease,
    migu,
    kugou,
    qq,
    lrclib,
    musixmatch,
    genius,
  };

  // Everything the user reads is in Simplified Chinese.
  //
  // The sources disagree: YouTube Music serves whatever the uploader
  // typed (often Traditional, from a Taiwanese or Hong Kong upload),
  // while the Chinese platforms serve the mainland catalogue's own
  // Simplified text. Converting once, here, means every source is
  // displayed the same way — and the panel never mixes two scripts in
  // the middle of a song.
  //
  // The dependencies are the sources' own data, not the `queries`
  // object: that object is rebuilt on every render, so a memo that
  // depended on it would recompute every time and never cache
  // anything.
  const displayLyrics = useMemo(() => {
    const out = {} as Record<LyricsSource, Lyrics | null>;
    out.ytmusic = toSimplifiedLyrics(ytmusic.data ?? null);
    out.netease = toSimplifiedLyrics(netease.data ?? null);
    out.migu = toSimplifiedLyrics(migu.data ?? null);
    out.kugou = toSimplifiedLyrics(kugou.data ?? null);
    out.qq = toSimplifiedLyrics(qq.data ?? null);
    out.lrclib = toSimplifiedLyrics(lrclib.data ?? null);
    out.musixmatch = toSimplifiedLyrics(musixmatch.data ?? null);
    out.genius = toSimplifiedLyrics(genius.data ?? null);
    return out;
  }, [
    ytmusic.data,
    netease.data,
    migu.data,
    kugou.data,
    qq.data,
    lrclib.data,
    musixmatch.data,
    genius.data,
  ]);

  let best: LyricsSource | null = null;
  for (const s of SOURCE_ORDER) {
    if (displayLyrics[s]?.kind === "timed") {
      best = s;
      break;
    }
  }
  if (!best) {
    for (const s of SOURCE_ORDER) {
      if (displayLyrics[s]?.kind === "plain") {
        best = s;
        break;
      }
    }
  }

  const isLoading = SOURCE_ORDER.some((s) => queries[s].isLoading);

  // Whether any source failed to *answer*, as opposed to answering "no
  // lyrics". Since providers stopped collapsing failures into null, this is
  // now knowable, and the panel needs it: "we could not reach Genius" and
  // "this track has no lyrics" call for different words and only one of
  // them is worth a retry button.
  const failed = SOURCE_ORDER.filter((s) => queries[s].isError);

  // A refetch of an errored query leaves `isError` true until it settles, so
  // without this the panel looks inert after Try again and invites a second
  // click, which is the request doubling the retry policy above exists to
  // avoid.
  const isRetrying = failed.some((s) => queries[s].isFetching);

  const retryFailed = () => {
    for (const s of failed) void queries[s].refetch();
  };

  return {
    queries,
    displayLyrics,
    best,
    isLoading,
    failed,
    isRetrying,
    retryFailed,
  };
}

/**
 * Convert a lyric set to Simplified Chinese.
 *
 * Only the text is converted — the timings are untouched, and the
 * source's name is kept as it was so the panel still says where the
 * words came from.
 */
function toSimplifiedLyrics(lyrics: Lyrics | null): Lyrics | null {
  if (!lyrics) return null;
  if (lyrics.kind === "plain") {
    return { ...lyrics, text: toSimplified(lyrics.text) };
  }
  return {
    ...lyrics,
    lines: lyrics.lines.map((line) => ({
      ...line,
      text: toSimplified(line.text),
    })),
  };
}
