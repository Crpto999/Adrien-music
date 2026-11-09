import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconLoader2 } from "@tabler/icons-react";
import { EntityHeader } from "@/components/shared/entity-header";
import { NeteaseDailyCover } from "@/components/shared/netease-daily-cover";
import { TrackList } from "@/components/shared/track-list";
import { TrackRowSkeletonList } from "@/components/shared/skeletons";
import { ErrorCard } from "@/components/shared/error-card";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";
import {
  neteaseDailyRecommend,
  type NeteaseSong,
} from "@/lib/providers/adapters/netease";
import { useNeteaseSession } from "@/lib/providers/netease-auth";
import {
  dailyQueueTracks,
  resolvedDailyTrack,
  useDailySourceUpgrade,
} from "@/lib/providers/daily";
import type { ShelfItem } from "@/lib/innertube/types";

export const Route = createFileRoute("/netease/daily")({
  component: NeteaseDailyPage,
});

/**
 * The NetEase daily recommendation, as its own page.
 *
 * The recommendation is the one thing YouTube Music has no equivalent
 * of: the platform picks a playlist of tracks a day, personalised to
 * the account. It lives in the sidebar's playlist list (and only
 * while the user is signed in to NetEase) rather than on the home
 * feed, because it is a *destination* — a list you open and play —
 * rather than one more shelf competing with the home feed for
 * attention.
 *
 * The rows are the standard track list, so the familiar controls
 * (selection, ratings, the ⋯ menu) all work. What differs is the
 * *source*: the picks are NetEase records, and whether each one can
 * actually be played is decided by the provider layer — see
 * `lib/providers/daily.ts`.
 */
function NeteaseDailyPage() {
  const t = useT();
  const { data: session } = useNeteaseSession();
  const signedIn = session?.signedIn === true;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["netease-daily-recommend"],
    queryFn: neteaseDailyRecommend,
    // The recommendation changes once a day; a long stale time keeps
    // it from re-fetching on every visit.
    staleTime: 30 * 60 * 1000,
    enabled: signedIn,
    retry: false,
  });

  const songs = useMemo<NeteaseSong[]>(() => data ?? [], [data]);

  // Keep the queue's upcoming picks pointed at their best source.
  useDailySourceUpgrade(songs);

  // The rows are drawn as ordinary shelf items so the shared track list
  // renders them exactly like every other list in the app. The
  // `provider` pair is what tells the playback store that the row's id
  // is a NetEase song id rather than a YouTube video id.
  const rows = useMemo<ShelfItem[]>(
    () =>
      songs.map((song) => ({
        kind: "song" as const,
        id: song.id,
        title: song.title,
        subtitle: song.artists.join(", "),
        artists: song.artists.map((name) => ({ name })),
        album: song.album ?? undefined,
        duration: song.duration,
        thumbnails: song.coverUrl
          ? [{ url: song.coverUrl, width: 544, height: 544 }]
          : [],
        provider: "netease" as const,
        providerTrackId: song.id,
      })),
    [songs],
  );

  /**
   * Start the list at a given pick.
   *
   * The queue is built from the picks (each carrying its NetEase
   * origin), and the pressed pick is resolved *before* it starts — so
   * it plays from a source that can actually serve it rather than
   * failing on a gated record. The rest of the list is upgraded in the
   * background by `useDailySourceUpgrade`.
   */
  const play = useCallback(
    async (startIndex: number) => {
      const song = songs[startIndex];
      if (!song) return;

      // The resolved pick, pointed at whichever provider can serve it.
      const resolved = await resolvedDailyTrack(song);

      // The queue: every pick, in order, each as a NetEase-origin
      // entry — except the pressed one, which now carries its
      // resolved source.
      const queue: QueueTrack[] = dailyQueueTracks(songs);
      queue[startIndex] = resolved;

      const store = usePlaybackStore.getState();
      store.setShuffle(false);
      store.setQueue(queue, startIndex);
    },
    [songs],
  );

  // The row click. Same as `play`, but the track the user pressed is
  // the one that starts — and it is resolved first, so it never starts
  // against a source that cannot serve it.
  const playFromRow = useCallback(
    (index: number) => {
      void play(index);
    },
    [play],
  );

  const playShuffle = useCallback(() => {
    if (songs.length === 0) return;
    const start = Math.floor(Math.random() * songs.length);
    void play(start).then(() => {
      usePlaybackStore.getState().setShuffle(true);
    });
  }, [play, songs.length]);

  // Signed out: the recommendation does not exist anonymously, so the
  // page says so instead of showing an empty list.
  if (!signedIn) {
    return (
      <div className="flex flex-col gap-6 px-6 pb-6 pt-3">
        <h1 className="text-3xl font-bold tracking-tight">
          {t("settings.providers.neteaseDaily")}
        </h1>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-hairline bg-w050 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            {t("settings.providers.neteaseDailySignIn")}
          </p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {t("settings.providers.neteaseSignInAction")}
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-8 px-6 pb-6 pt-3">
        <div className="flex items-center gap-2 px-1 py-4 text-sm text-muted-foreground">
          <IconLoader2 className="size-4 animate-spin" />
          {t("common.loading")}
        </div>
        <TrackRowSkeletonList count={10} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-6 px-6 pb-6 pt-3">
        <h1 className="text-3xl font-bold tracking-tight">
          {t("settings.providers.neteaseDaily")}
        </h1>
        <ErrorCard
          title={t("settings.providers.neteaseDaily")}
          message={(error as Error).message}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const metadata = t("settings.providers.neteaseDailyCount", {
    count: songs.length,
  });

  return (
    <div className="flex flex-col gap-6 px-6 pb-6 pt-3">
      <EntityHeader
        title={t("settings.providers.neteaseDaily")}
        subtitle={t("settings.providers.neteaseDailySubtitle")}
        metadata={metadata}
        thumbnails={[]}
        cover={<NeteaseDailyCover />}
        onPlay={() => void play(0)}
        onShuffle={playShuffle}
      />
      <TrackList tracks={rows} onPlayIndex={playFromRow} />
    </div>
  );
}
