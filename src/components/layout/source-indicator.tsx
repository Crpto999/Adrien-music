import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconCircleFilled,
  IconCircleOff,
  IconLoader2,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";
import {
  useAlternativeSources,
  usePlayability,
} from "@/lib/providers/alternatives";
import { switchTrackProvider } from "@/lib/providers/switch";
import { fetchSearch } from "@/lib/innertube/search";
import {
  neteaseSearch,
  type NeteaseSong,
} from "@/lib/providers/adapters/netease";
import {
  PROVIDER_LABELS,
  type ProviderId,
  type ProviderRef,
} from "@/lib/providers/types";
import type { ShelfItem } from "@/lib/innertube/types";

/**
 * 双源音源指示器：永远展示 youtube + 网易。
 *
 * - 有收录 → 高亮可点；无收录 → 置灰不可点（显示“不可播放/无此音源”）。
 * - 每行自带“重搜”按钮，打开 Top10 手动匹配弹窗；选中后写入
 *   `setTrackProvider(..., locked=true)`，绑定关系经由
 *   `rememberPlatformPair` 落盘到 `adrify-netease-ids`（IndexedDB）。
 */

export type SourceIndicatorProps = {
  track: QueueTrack | undefined;
  className?: string;
  variant?: "chip" | "ghost" | "bar";
};

const BOTH: ProviderId[] = ["youtube", "netease"];

function formatDuration(sec?: number): string {
  if (!sec || Number.isNaN(sec)) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type ManualCandidate = {
  key: string;
  title: string;
  subtitle?: string;
  thumbnails: { url: string }[];
  duration?: number;
  ref: ProviderRef;
};

export function SourceIndicator({
  track,
  className,
  variant = "ghost",
}: SourceIndicatorProps) {
  const t = useT();
  const [switching, setSwitching] = useState<ProviderId | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [manualProvider, setManualProvider] = useState<ProviderId | null>(null);

  const { alternatives, isLoading } = useAlternativeSources(track);
  const playability = usePlayability(alternatives);

  const provider = track?.provider ?? "youtube";
  const providerTrackId = track?.providerTrackId ?? track?.videoId ?? "";

  const switchTo = useCallback(
    async (ref: ProviderRef) => {
      if (!track) return;
      if (
        ref.provider === provider &&
        ref.providerTrackId === providerTrackId
      ) {
        return;
      }
      setSwitching(ref.provider);
      try {
        const ok = await switchTrackProvider(ref);
        if (!ok) {
          toast.error(
            t("settings.providers.switchFailed", {
              source: PROVIDER_LABELS[ref.provider],
            }),
          );
        } else {
          toast.success(
            t("settings.providers.switchedTo", {
              source: PROVIDER_LABELS[ref.provider],
            }),
          );
        }
      } catch (e) {
        toast.error(String(e));
      } finally {
        setSwitching(null);
      }
    },
    [track, provider, providerTrackId, t],
  );

  if (!track) return null;

  const refFor = (p: ProviderId): ProviderRef | null => {
    if (p === provider && providerTrackId) {
      return { provider: p, providerTrackId };
    }
    const found = alternatives.find((a) => a.provider === p);
    if (found) return found;
    // 落盘过的绑定也算可用：YouTube 行即便搜不到，也能靠 registry 指回网易反之亦然
    // 这里只处理“当前就是该源”的情况，其余以 alternatives 为准。
    return null;
  };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={switching !== null}
                aria-label={t("settings.providers.currentSource")}
                className={cn(
                  "h-7 gap-1.5 px-2 text-[11.5px] font-medium text-muted-foreground hover:text-foreground",
                  variant === "chip" &&
                    "h-8 rounded-full border border-hairline bg-surface/60 px-3",
                  variant === "bar" && "max-w-[9.5rem]",
                  className,
                )}
              >
                {switching ? (
                  <IconLoader2 className="size-3 animate-spin" />
                ) : (
                  <IconCircleFilled className="size-2 text-brand" />
                )}
                <span className="max-w-[9rem] truncate">
                  {PROVIDER_LABELS[provider]}
                </span>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {t("settings.providers.currentSource")} · {PROVIDER_LABELS[provider]}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" side="top" className="w-72">
          <DropdownMenuLabel>
            {t("settings.providers.playingFrom", {
              provider: PROVIDER_LABELS[provider],
            })}
          </DropdownMenuLabel>

          {track.discoveredOn && track.discoveredOn !== provider ? (
            <>
              <DropdownMenuLabel className="font-normal text-t8">
                {t("settings.providers.discoveredOn", {
                  provider: PROVIDER_LABELS[track.discoveredOn],
                })}
              </DropdownMenuLabel>
            </>
          ) : null}

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="font-normal text-t8">
            {t("settings.providers.switchSource")}
          </DropdownMenuLabel>

          {isLoading ? (
            <DropdownMenuItem disabled className="gap-2">
              <IconLoader2 className="size-3.5 animate-spin" />
              {t("settings.providers.searchingSources")}
            </DropdownMenuItem>
          ) : (
            BOTH.map((p) => {
              const ref = refFor(p);
              const isActive =
                p === provider &&
                !!ref &&
                ref.providerTrackId === providerTrackId;
              const key = ref ? `${ref.provider}:${ref.providerTrackId}` : p;
              const canPlay = ref ? playability.get(key) : false;
              // 无 ref = 该源无此歌 → 置灰；有 ref 但 probe 说播不了 → 置灰+不可播放
              const unavailable = !ref || canPlay === false;
              return (
                <div
                  key={p}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5",
                    unavailable && "opacity-45",
                  )}
                >
                  <button
                    type="button"
                    disabled={unavailable || isActive || switching !== null}
                    onClick={() => {
                      if (ref) void switchTo(ref);
                    }}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 text-left",
                      unavailable || isActive
                        ? "cursor-default"
                        : "cursor-pointer",
                    )}
                  >
                    {switching === p ? (
                      <IconLoader2 className="size-3.5 shrink-0 animate-spin" />
                    ) : isActive ? (
                      <IconCircleFilled className="size-2 shrink-0 text-brand" />
                    ) : unavailable ? (
                      <IconCircleOff className="size-3.5 shrink-0 text-t8" />
                    ) : (
                      <IconCircleFilled className="size-2 shrink-0 text-t8" />
                    )}
                    <span className="truncate text-[13px]">
                      {PROVIDER_LABELS[p]}
                    </span>
                    {isActive ? (
                      <span className="ml-auto shrink-0 text-[10.5px] text-brand">
                        {t("settings.providers.playingNow")}
                      </span>
                    ) : unavailable ? (
                      <span className="ml-auto shrink-0 text-[10.5px] text-t8">
                        {t("settings.providers.sourceUnavailable")}
                      </span>
                    ) : (
                      <span className="ml-auto shrink-0 text-[10.5px] text-t8">
                        {t("settings.providers.switchToHere")}
                      </span>
                    )}
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t("settings.providers.manualMatch", {
                      source: PROVIDER_LABELS[p],
                    })}
                    aria-label={t("settings.providers.manualMatch", {
                      source: PROVIDER_LABELS[p],
                    })}
                    className="h-7 w-7 shrink-0 p-0"
                    onClick={() => {
                      setManualProvider(p);
                    }}
                  >
                    <IconRefresh className="size-3.5" />
                  </Button>
                </div>
              );
            })
          )}

        </DropdownMenuContent>
      </DropdownMenu>

      <ManualMatchDialog
        track={track}
        provider={manualProvider}
        onClose={() => setManualProvider(null)}
      />
    </>
  );
}

function ManualMatchDialog({
  track,
  provider,
  onClose,
}: {
  track: QueueTrack;
  provider: ProviderId | null;
  onClose: () => void;
}) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<ManualCandidate[]>([]);
  const [binding, setBinding] = useState<string | null>(null);

  const query = useMemo(() => {
    const title = (track.title ?? "").trim();
    const artist = (track.artists?.[0]?.name ?? track.subtitle ?? "").trim();
    return [title, artist].filter(Boolean).join(" ").trim();
  }, [track]);

  useEffect(() => {
    if (!provider) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setCandidates([]);
    (async () => {
      try {
        if (provider === "netease") {
          const songs: NeteaseSong[] = await neteaseSearch(query, 10);
          if (cancelled) return;
          setCandidates(
            songs.slice(0, 10).map((s) => ({
              key: `netease:${s.id}`,
              title: s.title,
              subtitle: s.artists.join(", "),
              thumbnails: s.coverUrl ? [{ url: s.coverUrl }] : [],
              duration: s.duration,
              ref: { provider: "netease", providerTrackId: s.id },
            })),
          );
        } else {
          const res = await fetchSearch(query, "songs");
          if (cancelled) return;
          const items: ShelfItem[] = res.shelves
            .flatMap((sh) => sh.items)
            .filter((i) => i.kind === "song")
            .slice(0, 10);
          setCandidates(
            items.map((item) => ({
              key: `youtube:${item.id}`,
              title: item.title,
              subtitle:
                item.subtitle ??
                item.artists?.map((a) => a.name).join(", "),
              thumbnails: item.thumbnails?.map((th) => ({
                url: th.url,
              })) ?? [],
              duration: item.duration,
              ref: { provider: "youtube", providerTrackId: item.id },
            })),
          );
        }
      } catch {
        if (!cancelled) setCandidates([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, query]);

  const choose = useCallback(
    (c: ManualCandidate) => {
      const state = usePlaybackStore.getState();
      // 尽量定位到当前这首所在的 queue 槽；找不到就用正在播的槽。
      let idx = state.queue.findIndex((q) => q.videoId === track.videoId);
      if (idx < 0) idx = state.index;
      if (idx < 0) return;
      setBinding(c.key);
      try {
        // locked=true：用户手选最高优先级，不会被优先级顺序覆盖；
        // setTrackProvider 内部经 rememberPlatformPair 落盘双向绑定。
        state.setTrackProvider(idx, c.ref, undefined, true);
        toast.success(
          t("settings.providers.switchedTo", {
            source: PROVIDER_LABELS[c.ref.provider],
          }),
        );
        onClose();
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBinding(null);
      }
    },
    [onClose, t, track.videoId],
  );

  return (
    <Dialog open={provider !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {provider
              ? t("settings.providers.manualTitle", {
                  source: PROVIDER_LABELS[provider],
                })
              : ""}
          </DialogTitle>
          <DialogDescription>
            {t("settings.providers.manualDesc", { query })}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <IconLoader2 className="size-4 animate-spin" />
            <IconSearch className="size-4" />
            {t("settings.providers.searchingSources")}
          </div>
        ) : candidates.length === 0 ? (
          <p className="py-8 text-sm text-muted-foreground">
            {t("settings.providers.noOtherSource")}
          </p>
        ) : (
          <div className="flex max-h-[52vh] flex-col gap-1 overflow-y-auto pr-1">
            {candidates.map((c, i) => (
              <button
                key={c.key}
                type="button"
                onClick={() => choose(c)}
                disabled={binding !== null}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/60 disabled:opacity-60"
              >
                <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                {c.thumbnails[0]?.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.thumbnails[0].url}
                    alt=""
                    className="size-10 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <span className="grid size-10 shrink-0 place-items-center rounded-md bg-w080 text-xs text-muted-foreground">
                    {i + 1}
                  </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-medium">
                    {c.title}
                  </span>
                  {c.subtitle ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {c.subtitle}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatDuration(c.duration)}
                </span>
                {binding === c.key ? (
                  <IconLoader2 className="size-4 shrink-0 animate-spin" />
                ) : null}
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export const SOURCE_LABELS = PROVIDER_LABELS;
