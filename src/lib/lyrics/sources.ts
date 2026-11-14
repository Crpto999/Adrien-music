import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchLrclibLyrics } from "@/lib/lyrics/lrclib";
import { fetchMusixmatchLyrics } from "@/lib/lyrics/musixmatch";
import { fetchGeniusLyrics } from "@/lib/lyrics/genius";
import { fetchYtMusicLyrics } from "@/lib/lyrics/ytmusic";
import { fetchCnLyrics } from "@/lib/lyrics/cn";
import { fetchNeteaseLyrics } from "@/lib/lyrics/netease";
import { shouldRetryLyricsQuery } from "@/lib/lyrics/http";
import { normalizeLyrics } from "@/lib/lyrics/normalize";
import { cleanTrackTitle, lyricsArtist } from "@/lib/track-meta";
import { toSimplified } from "@/lib/chinese";
import { isYouTubeVideoId } from "@/lib/providers/queue";
import { useNetEaseIdStore } from "@/lib/store/netease-ids";
import type { Lyrics, TimedLine } from "@/lib/lyrics/types";
import type { ProviderId } from "@/lib/providers/types";
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

/**
 * The lyrics source that belongs to each audio provider.
 *
 * ## Why this mapping exists
 *
 * The source a track *plays from* and the source its *lyrics* come from
 * are the same decision: a song is one recording, and the platform
 * that serves the recording is the platform that has the words for it.
 *
 * The platform's own lyrics are keyed on its own track id, so they
 * cannot be the wrong song's words — which is exactly what the
 * text-matching sources (LRCLIB, Musixmatch, Genius) sometimes are.
 * So when the audio comes from NetEase, the lyrics come from NetEase:
 * the ids agree by construction, and there is no matching step that
 * could go wrong.
 *
 * Spotify and Apple Music are absent on purpose. They can serve
 * metadata but never audio, so a track never plays from them and there
 * is nothing for their lyrics to be paired with.
 */
const PROVIDER_LYRICS_SOURCE: Record<ProviderId, LyricsSource | null> = {
  youtube: "ytmusic",
  netease: "netease",
  migu: "migu",
  kugou: "kugou",
  qq: "qq",
  spotify: null,
  apple: null,
};

/**
 * The lyrics source that matches a track's audio provider.
 *
 * `null` for a provider with no lyrics of its own — Spotify and Apple
 * Music, which never serve audio either.
 */
export function lyricsSourceForProvider(
  provider: ProviderId | undefined,
): LyricsSource | null {
  if (!provider) return null;
  return PROVIDER_LYRICS_SOURCE[provider] ?? null;
}

/**
 * The sources to try, in order, for a track playing from `provider`.
 *
 * The provider's own source comes first — that is the pairing the app
 * promises: the audio and the words come from the same platform. The
 * rest of `SOURCE_ORDER` follows as fallbacks, so a track whose
 * provider has no lyrics still gets some.
 *
 * When the provider has no source of its own the order is
 * `SOURCE_ORDER` unchanged.
 */
export function orderedSourcesForProvider(
  provider: ProviderId | undefined,
  order: LyricsSource[] = SOURCE_ORDER,
): LyricsSource[] {
  const own = lyricsSourceForProvider(provider);
  if (!own) return order;
  return [own, ...order.filter((s) => s !== own)];
}

const ONE_HOUR = 60 * 60 * 1000;

/**
 * Bumped whenever the query we send changes shape. Lyrics are persisted to
 * IndexedDB for 7 days (`query-client.ts:9`, `App.tsx:49`), so without this a
 * user keeps yesterday's answer, looked up with yesterday's broken title
 * and artist, for a day after installing the fix.
 *
 * ## Why "v4"
 *
 * "v3" was the version in place while two independent faults made the
 * lookup fail:
 *
 *   - the YTM `/next` hop used the mobile client, which took 5.7 s - 9.8 s
 *     on its own and pushed the whole lookup past the 8 s deadline, so
 *     every lookup threw `LyricsTimeoutError`;
 *   - the YTM query was gated on the track already having a provider, so
 *     it did not run at all until the source resolution had landed.
 *
 * A React Query that rejects is *not* persisted — but the fallback
 * sources (LRCLIB / Musixmatch / Genius) answer `null` for most Chinese
 * songs, and a `null` *is* a success, and successes are what gets
 * dehydrated to IndexedDB. Those `null`s are what the user kept seeing
 * on every launch. Bumping the version changes every lyrics query key,
 * so the stale entries are orphaned rather than rehydrated.
 */
const LOOKUP_VERSION = "v4";

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

  // The provider the track is *playing from*, and the one it was
  // *discovered* on. They are usually the same, and when they are not
  // the discovery platform is still the platform whose catalogue the
  // song belongs to.
  //
  // The pairing the app promises — the audio and the words come from
  // the same platform — is keyed on the *playing* provider. A track
  // that plays from NetEase has its lyrics from NetEase, because
  // NetEase's lyrics are keyed on NetEase's own song id and so cannot
  // be another song's words.
  const playProvider = track?.provider;
  const ownLyricsSource = lyricsSourceForProvider(playProvider);

  // The sources to try, in order, for this track. The provider's own
  // source leads; the rest of the order follows as fallbacks.
  const sourceOrder = useMemo(
    () => orderedSourcesForProvider(playProvider),
    [playProvider],
  );  // One automatic retry, and none at all when the provider said we are
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
  // The track's YouTube video id, when it has one.
  //
  // A track from another provider carries a *synthetic* id in that field
  // — `netease_186016` — because the field is the app's YouTube video id
  // and a NetEase song id would be meaningless there (see
  // `providers/queue.ts`). YouTube Music has no lyrics tab for
  // `netease_186016`, so asking would cost a request and answer nothing.
  //
  // The provider decides it too: a track that explicitly belongs to
  // another platform is not a YouTube track, even if it happens to
  // carry a YouTube-shaped id (a NetEase daily pick that also exists
  // on YouTube keeps its NetEase id, and its lyrics come from NetEase).
  const ytVideoId =
    track && isYouTubeVideoId(track.videoId, playProvider)
      ? track.videoId
      : undefined;

  // Keyed on the videoId alone: no title, no artist, nothing fuzzy. This
  // is the query that structurally cannot come back with another song.
  //
  // It runs for any track that *has* a YouTube video id, whether or not
  // the track has been assigned a provider yet.
  //
  // That last part used to be gated on `ownLyricsSource === "ytmusic"`,
  // which meant the query only ran once the source resolution had
  // finished and written a provider onto the queue slot. But a plain
  // YouTube track starts with `provider === undefined`
  // (`shelfItemToTrack` leaves it unset), so between pressing play and
  // the resolution landing, the one provider that could answer was
  // disabled — and the fallback chain (LRCLIB / Musixmatch / Genius)
  // had already answered "nothing" for most Chinese songs. The panel
  // therefore showed "no lyrics" for a track that does have them.
  //
  // A track that plays from another platform has no YouTube video id
  // to ask about, and its lyrics come from that platform instead. A
  // track that *does* have a video id and later resolves to NetEase
  // keeps its NetEase lyrics as the provider's own; YTM simply becomes
  // one more fallback in the chain rather than the leader.
  const ytmusic = useQuery({
    queryKey: ["lyrics", "ytmusic", LOOKUP_VERSION, ytVideoId],
    queryFn: ({ signal }) => fetchYtMusicLyrics(ytVideoId, signal),
    enabled: !!ytVideoId && enabled,
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
  //
  // The registry is the other way the id is found: the pick was
  // hearted on YouTube, so it now lives in the YouTube liked list
  // under a YouTube video id, and the queue entry that comes back is
  // an ordinary YouTube row with no `discoveredTrackId` left. The
  // registry still knows the video holds NetEase record 186016, and
  // those are the right words for it.
  //
  // The registry is read through a subscription rather than a plain
  // lookup, so a mapping written *after* the track started playing
  // still turns the query on.
  const registrySongId = useNetEaseIdStore((s) =>
    track?.videoId ? s.byVideoId[track.videoId] : undefined,
  );
  const neteaseSongId =
    track?.provider === "netease"
      ? track.providerTrackId
      : track?.discoveredOn === "netease"
        ? track.discoveredTrackId
        : registrySongId;
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

  // The auto-picked source.
  //
  // The provider's *own* source wins outright when it has anything —
  // timed or plain. That is the pairing the app promises: the audio
  // and the words come from the same platform, and the platform's own
  // lyrics are keyed on its own track id, so they cannot be another
  // song's words.
  //
  // It used to be "the first *timed* source wins, whatever it is",
  // which broke the promise: a NetEase pick playing from YouTube would
  // show LRCLIB's timed lyrics ahead of NetEase's own, because
  // `sourceOrder` leads with the *playing* provider but the timed
  // sweep was over the whole order and LRCLIB came first with a
  // timed answer. The user asked for the platform's words, and got
  // somebody else's.
  //
  // Among the fallbacks the old rule still applies — timed beats
  // plain — because there the sources are matched by text and a timed
  // answer is the better one.
  let best: LyricsSource | null = null;
  if (ownLyricsSource && displayLyrics[ownLyricsSource]) {
    best = ownLyricsSource;
  } else {
    for (const s of sourceOrder) {
      if (displayLyrics[s]?.kind === "timed") {
        best = s;
        break;
      }
    }
    if (!best) {
      for (const s of sourceOrder) {
        if (displayLyrics[s]?.kind === "plain") {
          best = s;
          break;
        }
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
    /** The sources for this track, in the order they were tried. */
    sourceOrder,
    /** The provider's own source, when it has one. */
    ownLyricsSource,
    /** The NetEase song id the track is known by, when it has one. */
    neteaseSongId,
  };
}

/**
 * Prepare a lyric set for display: convert it to Simplified Chinese,
 * then clean it up.
 *
 * ## The order
 *
 * The conversion comes first, and it has to. Converting a line's text
 * can change how many characters it has — 愛 is one character in both
 * scripts, but a phrase can shorten — and the clean-up works on
 * character offsets: it finds the bracket that opens the answering
 * vocal by counting characters into the line. Doing the clean-up
 * first would have it count offsets in the text as it was *before* the
 * conversion, and the split would land in the wrong place.
 *
 * The word timings are converted too, and they needed it as much as
 * the line text did: the words carry their own copy of the text, and
 * the panel draws the words rather than the line. A line converted but
 * with its words left in the old script shows the two side by side.
 */
function toSimplifiedLyrics(lyrics: Lyrics | null): Lyrics | null {
  if (!lyrics) return null;
  if (lyrics.kind === "plain") {
    return {
      ...lyrics,
      text: toSimplified(lyrics.text),
      ...(lyrics.translation !== undefined
        ? { translation: toSimplified(lyrics.translation) }
        : {}),
    };
  }

  const converted: Lyrics = {
    ...lyrics,
    lines: lyrics.lines.map((line) => convertLine(line)),
    ...(lyrics.translation !== undefined
      ? {
          translation: lyrics.translation.map((line) => convertLine(line)),
        }
      : {}),
  };

  // The clean-up, on the converted text. See `normalize.ts` for what it
  // does and — more importantly — what it leaves alone.
  return normalizeLyrics(converted);
}

/**
 * One line, converted to Simplified Chinese.
 *
 * The timings are untouched; only the text is converted. The answering
 * vocal is converted with the line it belongs to.
 */
function convertLine(line: TimedLine): TimedLine {
  return {
    ...line,
    text: toSimplified(line.text),
    ...(line.words
      ? {
          words: line.words.map((word) => ({
            ...word,
            text: toSimplified(word.text),
          })),
        }
      : {}),
    ...(line.background ? { background: convertLine(line.background) } : {}),
  };
}
