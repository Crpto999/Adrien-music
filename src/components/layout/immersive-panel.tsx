import { useCallback, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  IconHeart,
  IconHeartFilled,
  IconLoader2,
  IconMessageCircle,
  IconPlayerPlay,
} from "@tabler/icons-react";

import { AnimatedTabs } from "@/components/ui/animated-tabs";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { formatRelative, type TranslateFn } from "@/lib/format";
import { useNeteaseSongId } from "@/lib/netease/song-id";
import { playSimilarSongWithFeedback } from "@/lib/netease/similar-play";
import {
  neteaseArtistByName,
  neteaseArtistWiki,
  neteaseCommentReplies,
  neteaseComments,
  neteaseSongWiki,
  NETEASE_SORT_HOT,
  NETEASE_SORT_LATEST,
  type NeteaseArtistWiki,
  type NeteaseComment,
  type NeteaseSimilarSong,
  type NeteaseSongWiki,
} from "@/lib/netease/social";
import type { QueueTrack } from "@/lib/store/playback";

/**
 * The immersive layout's panel: what people wrote about this song, and
 * what the platform knows about it.
 *
 * ## Why it is here and not in the lyrics layout
 *
 * The immersive layout is the one that shows the art on its own, with
 * the title over it. It was the emptiest of the three — a wall of
 * picture and a title, with nothing to *do* in it. The comments and the
 * 百科 are exactly what fills that space: they are about the track
 * that is playing, they are read rather than watched, and they want a
 * column of text over the art rather than a second picture of it.
 *
 * So the layout is not "the cover, plus a panel somewhere". It *is* the
 * panel, with the art behind it.
 *
 * ## The three tabs
 *
 * - **热评** — the hot ones, ranked by likes. A fixed handful.
 * - **最新** — the most recent ones, newest first. It goes on forever,
 *   so it pages.
 * - **百科** — the platform's own page for the recording: its genres,
 *   its language, its tempo, its credits, the artist behind it, and
 *   the songs it sounds like.
 *
 * They answer different questions, so they are kept apart: "what did
 * people say" and "what are people saying" are not the same thing, and
 * mixing them would bury the second under the first.
 */

/**
 * The three tabs.
 *
 * They answer different questions, so they are kept apart: "what did
 * people say" and "what are people saying" are not the same thing, and
 * mixing them would bury the second under the first.
 */
type Tab = "hot" | "latest" | "wiki";

/** How long a fetched page of comments stays good. */
const FIVE_MINUTES = 5 * 60 * 1000;

/** How long the 百科 stays good. */
const ONE_HOUR = 60 * 60 * 1000;

export function ImmersivePanel({ track }: { track: QueueTrack }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("hot");

  // The id every one of these is keyed on. Resolving it is the panel's
  // first job, and it happens once — the comments, the replies and the
  // 百科 all hang off the same recording.
  const { songId, isLoading: idLoading, isMatched } = useNeteaseSongId(track);

  const tabs = useMemo(
    () => [
      { id: "hot", label: t("netease.hot") },
      { id: "latest", label: t("netease.latest") },
      { id: "wiki", label: t("netease.wiki") },
    ],
    [t],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      // The panel is content, not blank surface: a click on its
      // background must not collapse the full-screen view.
      data-blank-exclude
    >
      {/* The tab strip sits on the panel's own top edge, so the three
          panels read as one card with three faces rather than as a tab
          bar floating above a separate box. The underline variant
          draws its own bottom rule. */}
      <div className="flex shrink-0 justify-center px-4">
        <AnimatedTabs
          tabs={tabs}
          activeTab={tab}
          onChange={(id) => setTab(id as Tab)}
          variant="underline"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {!songId ? (
          <PanelNotice
            loading={idLoading}
            text={
              idLoading
                ? t("netease.resolving")
                : t("netease.notInCatalogue")
            }
          />
        ) : tab === "wiki" ? (
          <WikiTab track={track} songId={songId} isMatched={isMatched} />
        ) : (
          <CommentsTab
            songId={songId}
            sortType={tab === "hot" ? NETEASE_SORT_HOT : NETEASE_SORT_LATEST}
            isMatched={isMatched}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The comment list                                                    */
/* ------------------------------------------------------------------ */

function CommentsTab({
  songId,
  sortType,
  isMatched,
}: {
  songId: string;
  sortType: number;
  isMatched: boolean;
}) {
  const t = useT();

  // The recent list is walked by a cursor rather than by an offset, and
  // the hot list by an offset rather than by a cursor — so the page
  // parameter carries both, and each one is used only by the list that
  // wants it.
  type PageParam = { page: number; cursor: string | null };

  const query = useInfiniteQuery({
    queryKey: ["netease-comments", sortType, songId],
    queryFn: ({ pageParam }) =>
      neteaseComments(
        songId,
        sortType,
        pageParam.page,
        pageParam.cursor,
      ),
    initialPageParam: { page: 1, cursor: null } as PageParam,
    getNextPageParam: (last, _all, lastPageParam) => {
      if (!last.hasMore) return undefined;
      if (last.throttled) return undefined;
      // The hot list is walked by an offset into its ranking, which the
      // backend works out from the page number alone. The recent list
      // is walked by the cursor the previous page answered with.
      return {
        page: lastPageParam.page + 1,
        cursor: last.cursor,
      };
    },
    staleTime: FIVE_MINUTES,
    retry: false,
  });

  const pages = query.data?.pages ?? [];
  const comments = pages.flatMap((page) => page.comments);
  const throttled = pages.some((page) => page.throttled);

  if (query.isLoading) {
    return <PanelNotice loading text={t("netease.loadingComments")} />;
  }
  if (throttled) {
    return <PanelNotice text={t("netease.throttled")} />;
  }
  if (comments.length === 0) {
    return <PanelNotice text={t("netease.noComments")} />;
  }

  return (
    <div className="app-scroll min-h-0 flex-1 overflow-y-auto">
      <div className="divide-y divide-w050">
        {comments.map((comment) => (
          <CommentRow key={comment.id} comment={comment} songId={songId} />
        ))}
      </div>

      {query.hasNextPage ? (
        <div className="flex justify-center p-4">
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="rounded-full border border-w080 bg-w050 px-4 py-1.5 text-[15px] text-(--fs-sub) transition-colors duration-200 hover:bg-w080 hover:text-(--fs-title) disabled:opacity-50"
          >
            {query.isFetchingNextPage ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : (
              t("netease.loadMore")
            )}
          </button>
        </div>
      ) : null}

      {isMatched ? (
        <p className="px-5 py-3 text-center text-[14px] text-(--fs-label)">
          {t("netease.uncertainMatch")}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One comment                                                         */
/* ------------------------------------------------------------------ */

function CommentRow({
  comment,
  songId,
  nested = false,
}: {
  comment: NeteaseComment;
  songId: string;
  /** A reply under another comment. */
  nested?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [replies, setReplies] = useState<NeteaseComment[] | null>(null);
  const [loading, setLoading] = useState(false);

  // The replies are behind their own call: a track with a hundred
  // comments does not fetch a hundred sets of them.
  const toggle = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (replies) return;
    setLoading(true);
    try {
      const set = await neteaseCommentReplies(songId, comment.id);
      setReplies(set.replies);
    } finally {
      setLoading(false);
    }
  }, [comment.id, open, replies, songId]);

  // A comment with a hundred thousand likes is one people agreed with;
  // the accent says so at a glance, the way the platform's own list
  // does.
  const hot = comment.likedCount >= 1000;

  return (
    <div className={cn("px-5 py-3.5", nested && "px-3 py-2.5")}>
      <div className="flex gap-3">
        {comment.avatarUrl ? (
          <img
            src={comment.avatarUrl}
            alt=""
            className="size-9 shrink-0 rounded-full bg-w070 object-cover"
            loading="lazy"
          />
        ) : (
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-w070 text-[13px] text-(--fs-label)">
            {(comment.nickname || "?").slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-[15px]">
            <span className="truncate font-medium text-(--fs-title)">
              {comment.nickname || t("netease.anonymous")}
            </span>
            {comment.location ? (
              <span className="shrink-0 text-[13px] text-(--fs-label)">
                {comment.location}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 text-[13px] text-(--fs-label)">
              {formatCommentTime(comment.timeMs, t)}
            </span>
          </div>

          <p
            className={cn(
              "mt-1.5 text-[15px] leading-relaxed whitespace-pre-wrap",
              nested ? "text-(--fs-sub)" : "text-(--fs-title)/85",
            )}
          >
            {comment.content}
          </p>

          <div className="mt-2 flex items-center gap-3.5 text-[13px] text-(--fs-label)">
            <span
              className={cn(
                "flex items-center gap-1",
                hot && "font-medium text-brand",
              )}
            >
              {hot ? (
                <IconHeartFilled className="size-4" />
              ) : (
                <IconHeart className="size-4" />
              )}
              {comment.likedCount > 0 ? comment.likedCount : null}
            </span>
            {comment.replyCount > 0 ? (
              <button
                type="button"
                onClick={toggle}
                className="flex items-center gap-1 transition-colors duration-200 hover:text-brand"
              >
                <IconMessageCircle className="size-4" />
                {comment.replyCount}
              </button>
            ) : null}
          </div>

          {open ? (
            <div className="mt-2 border-l border-w080 pl-3">
              {loading ? (
                <IconLoader2 className="size-4 animate-spin text-(--fs-label)" />
              ) : replies && replies.length > 0 ? (
                replies.map((reply) => (
                  <CommentRow
                    key={reply.id}
                    comment={reply}
                    songId={songId}
                    nested
                  />
                ))
              ) : (
                <p className="py-1 text-[12px] text-(--fs-label)">
                  {t("netease.noReplies")}
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The 百科                                                            */
/* ------------------------------------------------------------------ */

function WikiTab({
  track,
  songId,
  isMatched,
}: {
  track: QueueTrack;
  songId: string;
  isMatched: boolean;
}) {
  const t = useT();

  const wiki = useQuery({
    queryKey: ["netease-wiki", songId],
    queryFn: () => neteaseSongWiki(songId),
    staleTime: ONE_HOUR,
    retry: false,
  });

  const detail = wiki.data;

  // The artist card is about the track that is *playing*, not about
  // whichever recording the platform matched: a cover, a live cut or a
  // different song entirely can share a title, and the artist of that
  // recording is somebody else's.
  //
  // So the artist is looked for by the name the *playing* track carries
  // — and, when that name finds nobody, by the name the matched
  // recording carries, which is the next best thing.
  //
  // The two are joined rather than one replacing the other: a track can
  // credit several artists, and the card should name the one the
  // recording was made by.
  const artist = useQuery({
    queryKey: ["netease-artist", songId, detail?.artistName ?? ""],
    queryFn: async () => {
      const names = [
        ...detail?.artistName ? [detail.artistName] : [],
        ...(track.artists ?? [])
          .map((a) => (typeof a === "string" ? a : a.name))
          .filter(Boolean),
      ].filter((name, index, all) => all.indexOf(name) === index);

      for (const name of names) {
        const found = await neteaseArtistByName(name);
        if (found) return found;
      }
      if (detail?.artistId) return neteaseArtistWiki(detail.artistId);
      return null;
    },
    // The artist card is only meaningful once the recording's own
    // entry has been read — the recording's canonical artist name is
    // the first one tried.
    enabled: !!detail,
    staleTime: ONE_HOUR,
    retry: false,
  });

  if (wiki.isLoading) {
    return <PanelNotice loading text={t("netease.loadingWiki")} />;
  }

  const hasContent =
    detail &&
    (detail.styles.length > 0 ||
      detail.tags.length > 0 ||
      detail.album ||
      detail.language ||
      detail.bpm ||
      detail.awards.length > 0 ||
      detail.instruments.length > 0 ||
      detail.producers.length > 0 ||
      detail.entertainment.length > 0 ||
      detail.similar.length > 0);

  return (
    <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {!hasContent ? (
        <PanelNotice text={t("netease.noWiki")} />
      ) : (
        <div className="flex flex-col gap-4">
          <WikiFacts detail={detail!} />

          {artist.data ? <ArtistCard artist={artist.data} /> : null}

          {detail!.similar.length > 0 ? (
            <SimilarCard songs={detail!.similar} />
          ) : null}

          {isMatched ? (
            <p className="pt-1 text-center text-[14px] text-(--fs-label)">
              {t("netease.uncertainMatch")}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The song's own facts: its genres, its language, its credits. */
function WikiFacts({ detail }: { detail: NeteaseSongWiki }) {
  const t = useT();
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
      {detail.styles.length > 0 ? (
        <WikiRow label={t("netease.wikiStyles")} value={detail.styles.join(" · ")} />
      ) : null}
      {detail.tags.length > 0 ? (
        <WikiRow label={t("netease.wikiTags")} value={detail.tags.join(" · ")} />
      ) : null}
      {detail.language ? (
        <WikiRow label={t("netease.wikiLanguage")} value={detail.language} />
      ) : null}
      {detail.bpm ? (
        <WikiRow label={t("netease.wikiBpm")} value={detail.bpm} />
      ) : null}
      {detail.album ? (
        <WikiRow label={t("netease.wikiAlbum")} value={detail.album} />
      ) : null}
      {detail.releaseTimeMs ? (
        <WikiRow
          label={t("netease.wikiReleased")}
          value={new Date(detail.releaseTimeMs).toLocaleDateString()}
        />
      ) : null}
      {detail.instruments.length > 0 ? (
        <WikiRow
          label={t("netease.wikiInstruments")}
          value={detail.instruments.join(" · ")}
        />
      ) : null}
      {detail.producers.length > 0 ? (
        <WikiRow
          label={t("netease.wikiProducers")}
          value={detail.producers.join(" · ")}
        />
      ) : null}
      {detail.awards.length > 0 ? (
        <WikiRow label={t("netease.wikiAwards")} value={detail.awards.join(" · ")} />
      ) : null}
      {detail.entertainment.length > 0 ? (
        <WikiRow
          label={t("netease.wikiEntertainment")}
          value={detail.entertainment.join(" · ")}
        />
      ) : null}
    </div>
  );
}

/** One labelled fact. */
function WikiRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 text-[15px]">
      <span className="w-[76px] shrink-0 text-(--fs-label)">{label}</span>
      <span className="min-w-0 flex-1 text-(--fs-title)/85">{value}</span>
    </div>
  );
}

/** The artist behind the recording. */
function ArtistCard({ artist }: { artist: NeteaseArtistWiki }) {
  const t = useT();
  return (
    <section className="rounded-xl border border-w080 bg-w030 p-4">
      <h3 className="mb-2.5 text-[15px] font-semibold text-(--fs-title)">
        {t("netease.wikiArtist")}
      </h3>
      <div className="flex gap-3.5">
        {artist.pictureUrl ? (
          <img
            src={artist.pictureUrl}
            alt=""
            className="size-16 shrink-0 rounded-lg bg-w070 object-cover"
            loading="lazy"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-medium text-(--fs-title)">
            {artist.name}
          </p>
          {artist.aliases.length > 0 ? (
            <p className="mt-0.5 truncate text-[14px] text-(--fs-label)">
              {artist.aliases.join(" / ")}
            </p>
          ) : null}
          {artist.biography ? (
            <p className="mt-1.5 line-clamp-4 text-[12.5px] leading-relaxed text-(--fs-sub)">
              {artist.biography}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * The songs NetEase says this one sounds like.
 *
 * Each row is playable: the list is the platform's own answer about
 * which songs sound like this one, and every row carries the
 * catalogue's id for the recording, so pressing one plays that exact
 * record. NetEase serves it when the platform will; when it will not,
 * the app's own cross-provider machinery finds the same recording
 * elsewhere with the same scoring rules — and the player's source
 * switcher then lets the user move between them by hand.
 */
function SimilarCard({ songs }: { songs: NeteaseSimilarSong[] }) {
  const t = useT();
  const [pending, setPending] = useState<string | null>(null);

  const play = useCallback(
    async (song: NeteaseSimilarSong) => {
      if (pending) return;
      setPending(song.id);
      try {
        await playSimilarSongWithFeedback(song);
      } finally {
        setPending(null);
      }
    },
    [pending],
  );

  return (
    <section className="rounded-xl border border-w080 bg-w030 p-4">
      <h3 className="mb-2.5 text-[15px] font-semibold text-(--fs-title)">
        {t("netease.wikiSimilar")}
      </h3>
      <div className="flex flex-col gap-1">
        {songs.map((song) => (
          <button
            key={song.id}
            type="button"
            onClick={() => void play(song)}
            disabled={pending !== null}
            title={t("netease.wikiSimilarPlay")}
            className="group flex items-center gap-3 rounded-lg px-1.5 py-2 text-left transition-colors duration-200 hover:bg-w050 disabled:opacity-60"
          >
            {song.pictureUrl ? (
              <img
                src={song.pictureUrl}
                alt=""
                className="size-11 shrink-0 rounded-md bg-w070 object-cover"
                loading="lazy"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] text-(--fs-title)">
                {song.title}
              </p>
              <p className="truncate text-[13px] text-(--fs-label)">
                {song.artists.join(" / ")}
              </p>
            </div>
            {song.album ? (
              <span className="max-w-[160px] shrink-0 truncate text-[13px] text-(--fs-label)">
                {song.album}
              </span>
            ) : null}
            {pending === song.id ? (
              <IconLoader2 className="size-4 shrink-0 animate-spin text-brand" />
            ) : (
              <IconPlayerPlay className="size-4 shrink-0 text-t8 opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

/**
 * The panel's empty / loading state.
 *
 * A note rather than a spinner on its own: the panel has to say *what*
 * it has nothing for, because "nothing here" and "not found" and
 * "rate-limited" are three different answers.
 */
function PanelNotice({
  text,
  loading = false,
}: {
  text: string;
  loading?: boolean;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-10">
      <div className="flex flex-col items-center gap-2.5 text-center">
        {loading ? (
          <IconLoader2 className="size-5 animate-spin text-(--fs-label)" />
        ) : (
          <IconMessageCircle className="size-5 text-(--fs-label)" />
        )}
        <p className="text-[13px] text-(--fs-sub)">{text}</p>
      </div>
    </div>
  );
}

/**
 * When a comment was written, in the reader's own words.
 *
 * A relative time for anything within a week ("3 小时前") and a date
 * for anything older — a timestamp three years old is more legible as
 * a date than as "3 年前".
 */
function formatCommentTime(timeMs: number, t: TranslateFn): string {
  if (!timeMs) return "";
  return formatRelative(Math.floor(timeMs / 1000), t);
}
