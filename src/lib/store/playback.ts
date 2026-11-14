import { create, type StateCreator } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import { emit } from "@tauri-apps/api/event";
import type { ShelfItem, Thumbnail } from "@/lib/innertube/types";
import { isFloatingPlayerWindow } from "@/lib/floating-player";
import { usePlaybackSettings } from "./playback-settings";
import { safeLocalStorage } from "./safe-storage";
import type { ProviderId, ProviderRef } from "@/lib/providers/types";
import { syntheticQueueId } from "@/lib/providers/queue";
import { rememberPlatformPair, useNetEaseIdStore } from "./netease-ids";

export type QueueTrack = {
  videoId: string;
  title: string;
  subtitle?: string;
  artists?: { id?: string; name: string }[];
  album?: string;
  /** Browse id for `album`, when the source row carried one. Lets the
   *  player's album line link through to the album page. */
  albumId?: string;
  thumbnails: Thumbnail[];
  /** Original duration from browse responses, may be undefined until /player resolves. */
  duration?: number;
  /**
   * The provider this track is being played from.
   *
   * Absent means YouTube — the app's original source, and the one the
   * persisted queue was written against. `videoId` remains the
   * YouTube-side id even for other providers, so every existing
   * lookup keyed on it keeps working.
   */
  provider?: ProviderId;
  /**
   * That provider's own id for the track — a NetEase song id, for
   * example. Only set when it differs from `videoId`.
   */
  providerTrackId?: string;
  /**
   * The provider the track was *discovered* on, when that differs from
   * the one it plays from. A NetEase daily-recommendation track served
   * by YouTube is discovered on NetEase and plays from YouTube — worth
   * showing, because the two are different recordings of the same song.
   */
  discoveredOn?: ProviderId;
  /**
   * The id the track had on its origin provider, when it no longer
   * plays from there.
   *
   * A NetEase daily pick that NetEase will not serve is redirected to
   * YouTube, and the NetEase song id goes with the redirection — but
   * the platform's own lyrics are still the right words for that
   * song, and they are keyed on the NetEase id. Without this the pick
   * would lose its lyrics the moment it was upgraded.
   */
  discoveredTrackId?: string;
  /**
   * The user picked this source by hand.
   *
   * The source switcher moves a track to another platform on purpose,
   * and that choice outranks the priority order: a track the user
   * pointed at NetEase keeps playing from NetEase even after the
   * order changes. Without this flag the order would silently undo
   * the switch the moment the track was re-resolved.
   */
  sourceLocked?: boolean;
};

export type RepeatMode = "off" | "all" | "one";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

export type PlaybackState = {
  // Queue
  queue: QueueTrack[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;

  /**
   * Playback history — the tracks that have actually played, oldest
   * first.
   *
   * This is a log of its own, NOT the part of the queue that sits
   * behind the current track. The queue is a *plan* (what is going to
   * play) and is routinely replaced wholesale — playing an album, or
   * a single track from search, throws the old plan away — so it
   * cannot double as the record of what was heard. Deriving the
   * history from the queue's prefix therefore showed an empty history
   * almost every time.
   *
   * The log is append-only and strictly ordered: every track that
   * starts playing is appended, in the order it started. Going back
   * with Previous does not rewrite it — the track is simply played
   * again and appears again, which is what "strictly record the order"
   * means for a log.
   *
   * Session-scoped: it is not persisted, so a fresh launch starts with
   * an empty history.
   */
  history: QueueTrack[];

  // Current track status
  status: LoadStatus;
  error?: string;
  /** Resolved stream URL for the current track (set by AudioEngine). */
  streamUrl?: string;

  // Transport
  playing: boolean;
  /** 0..1 — store as fraction; UI can scale. */
  volume: number;
  muted: boolean;
  /** Current playhead, seconds. */
  position: number;
  /** Real duration (from audio element, once loaded). */
  duration: number;
  /** When the user drags the slider, we seek here on release. */
  pendingSeek?: number;

  /** When true, auto-append radio tracks to the queue when the last one ends. */
  autoRadio: boolean;
  /**
   * Bumped by clearQueue. The audio engine fetches radio once per seed
   * track; after a clear the same track is the tail again and must be
   * allowed to seed a fresh batch, so the engine keys its guard on
   * seed + epoch rather than the seed alone.
   */
  radioEpoch: number;

  /**
   * Pending /next continuation for the current queue's source — set when
   * the queue came from a server-side playlist shuffle whose remaining
   * permutation is still on YTM's side. The audio engine drains it as
   * playback nears the tail; any action that replaces the queue clears it.
   */
  queueContinuation?: string;

  // Actions — queue
  playNow: (track: QueueTrack | ShelfItem, extras?: QueueTrack[]) => void;
  setQueue: (tracks: QueueTrack[], startIndex?: number) => void;
  playShelfItems: (items: ShelfItem[], startIndex: number) => void;
  enqueueNext: (track: QueueTrack | ShelfItem) => void;
  enqueueEnd: (track: QueueTrack | ShelfItem) => void;
  appendToQueue: (tracks: (QueueTrack | ShelfItem)[]) => void;
  /**
   * Move a queue slot to a different provider.
   *
   * Used by the source switcher: the same recording on another
   * platform is a different file, and the user picks which one plays.
   *
   * `origin` says where the track was *found*, for the case where the
   * source that will play it is not the one the user picked it on.
   */
  setTrackProvider: (
    index: number,
    ref: ProviderRef,
    origin?: { discoveredOn?: ProviderId; discoveredTrackId?: string },
    locked?: boolean,
  ) => void;
  removeAt: (index: number) => void;
  moveTrack: (from: number, to: number) => void;
  /** Drop everything after the current track; it keeps playing. */
  clearQueue: () => void;
  /** Empty the queue and stop audio outright (account switch). */
  stopPlayback: () => void;
  /** Forget the playback history (the History tab's own clear action). */
  clearHistory: () => void;
  /**
   * Play a track from the playback history.
   *
   * A history entry is not a queue slot — the queue has moved on since
   * it was played — so it is played the way any other track is picked:
   * it cuts in line at the front of the queue.
   */
  playFromHistory: (historyIndex: number) => void;
  setAutoRadio: (on: boolean) => void;
  setQueueContinuation: (token?: string) => void;

  // Actions — transport
  toggle: () => void;
  setPlaying: (playing: boolean) => void;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;

  // Actions — status (used by AudioEngine)
  setStatus: (status: LoadStatus, error?: string) => void;
  setStreamUrl: (url?: string) => void;
  setPosition: (position: number) => void;
  setDuration: (duration: number) => void;
  seek: (seconds: number) => void;
  clearPendingSeek: () => void;

  // Actions — volume
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  setShuffle: (on: boolean) => void;
  cycleRepeat: () => void;
};

function shelfItemToTrack(item: ShelfItem | QueueTrack): QueueTrack | null {
  if ("videoId" in item) return item;
  if (item.kind !== "song") return null;
  // A row from another provider (the NetEase daily picks) carries that
  // provider's own id. It has to become the queue's `videoId` in the
  // synthetic `provider_id` form, because the YouTube-side id is what
  // the rest of the app treats as "this track's id" — and a NetEase
  // song id would be meaningless there.
  const provider = item.provider;
  if (provider && provider !== "youtube") {
    const providerTrackId = item.providerTrackId ?? item.id;
    return {
      videoId: syntheticQueueId(provider, providerTrackId),
      title: item.title,
      subtitle: item.subtitle,
      artists: item.artists,
      album: item.album,
      albumId: item.albumId,
      thumbnails: item.thumbnails,
      duration: item.duration,
      provider,
      providerTrackId,
    };
  }  return {
    videoId: item.id,
    title: item.title,
    subtitle: item.subtitle,
    artists: item.artists,
    album: item.album,
    albumId: item.albumId,
    thumbnails: item.thumbnails,
    duration: item.duration,
    // A YouTube row that the app knows is really a NetEase recording.
    //
    // This is the case the heart flow creates: a NetEase daily pick
    // hearted on YouTube lives in the YouTube liked list under a
    // YouTube video id, and comes back out as an ordinary YouTube row.
    // The registry still holds the correspondence, so the row can
    // declare where it came from — which is what lets the player show
    // the origin, and what lets the NetEase side of the switcher offer
    // the exact record rather than a search result.
    ...neteaseOriginFor(item.id),
  };
}

/**
 * The NetEase origin of a YouTube video, when the app knows it.
 *
 * Read imperatively rather than through a subscription: the caller is
 * an action, not a component, and the value it needs is the one that
 * was known when the row was mapped.
 */
function neteaseOriginFor(videoId: string): {
  discoveredOn?: ProviderId;
  discoveredTrackId?: string;
} {
  const songId = useNetEaseIdStore.getState().byVideoId[videoId];
  if (!songId) return {};
  return { discoveredOn: "netease", discoveredTrackId: songId };
}

function fisherYates<T>(arr: readonly T[]): T[] {
  const result = arr.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const MAX_PERSISTED_QUEUE_TRACKS = 300;

function compactPersistedQueue(
  queue: QueueTrack[],
  index: number,
): QueueTrack[] {
  if (queue.length <= MAX_PERSISTED_QUEUE_TRACKS) return queue;
  const safeIndex = Math.max(0, Math.min(index, queue.length - 1));
  const before = Math.floor((MAX_PERSISTED_QUEUE_TRACKS - 1) / 2);
  const start = Math.max(0, safeIndex - before);
  return queue.slice(start, start + MAX_PERSISTED_QUEUE_TRACKS);
}

function persistedQueueIndex(queue: QueueTrack[], index: number): number {
  if (queue.length <= MAX_PERSISTED_QUEUE_TRACKS) return index;
  const safeIndex = Math.max(0, Math.min(index, queue.length - 1));
  const before = Math.floor((MAX_PERSISTED_QUEUE_TRACKS - 1) / 2);
  return safeIndex - Math.max(0, safeIndex - before);
}

/**
 * Soft cap on the playback history log.
 *
 * The log is a session's worth of played tracks. At three minutes each,
 * 200 entries is roughly ten hours of listening — well past what a
 * session holds, and small enough that the History tab renders without
 * a virtualiser.
 */
const MAX_HISTORY_TRACKS = 200;

/**
 * Append a track to the playback history.
 *
 * The log is append-only and strictly ordered: every track that starts
 * playing is appended, in the order it started. Replaying a track —
 * stepping back with Previous, or picking it again from search —
 * appends it again, because the log records what happened rather than
 * what is distinct.
 */
function appendHistory(
  history: QueueTrack[],
  track: QueueTrack | undefined,
): QueueTrack[] {
  if (!track) return history;
  const next = [...history, track];
  return next.length > MAX_HISTORY_TRACKS
    ? next.slice(next.length - MAX_HISTORY_TRACKS)
    : next;
}

/**
 * Debounced JSON storage for the persisted playback blob.
 *
 * `position` is part of that blob, so persist fires on every `timeupdate`
 * (~4×/s). `createJSONStorage` would `JSON.stringify` the whole queue (up to
 * 300 tracks) on each of those calls and only debounce the write. Holding the
 * object and stringifying inside the timer means one serialize per second at
 * most, however often the state changes.
 */
function createDebouncedJSONStorage<S>(delay = 1000): PersistStorage<S> {
  const pending = new Map<string, { value: unknown; timer: number }>();
  return {
    getItem: (name) => {
      const raw = safeLocalStorage.getItem(name) as string | null;
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      if (typeof window === "undefined") {
        safeLocalStorage.setItem(name, JSON.stringify(value));
        return;
      }
      const existing = pending.get(name);
      if (existing) window.clearTimeout(existing.timer);
      const timer = window.setTimeout(() => {
        const item = pending.get(name);
        if (!item) return;
        pending.delete(name);
        safeLocalStorage.setItem(name, JSON.stringify(item.value));
      }, delay);
      pending.set(name, { value, timer });
    },
    removeItem: (name) => {
      const existing = pending.get(name);
      if (existing) window.clearTimeout(existing.timer);
      pending.delete(name);
      safeLocalStorage.removeItem(name);
    },
  };
}

const playbackStateCreator: StateCreator<PlaybackState> = (set, get) => ({
  queue: [],
  index: -1,
  shuffle: false,
  repeat: "off",
  autoRadio: false,
  radioEpoch: 0,
  queueContinuation: undefined,

  // Session-scoped: not persisted, so a fresh launch starts empty.
  history: [],

  status: "idle",
  error: undefined,
  streamUrl: undefined,

  playing: false,
  volume: 0.8,
  muted: false,
  position: 0,
  duration: 0,
  pendingSeek: undefined,

  playNow: (track, extras) => {
    const mapped = shelfItemToTrack(track);
    if (!mapped) return;

    // "Cut in line": the track the user picked plays right now, and the
    // tracks that were already queued move behind it.
    //
    // The queue is the user's plan, and it is built up track by track
    // ("add to queue", "play next", an album's track list). Replacing
    // it wholesale on every single-track play threw that plan away
    // the moment the user clicked anything that was not part of it,
    // which is why the queue felt like it had no consistent insertion
    // rule. Moving the queue behind the new track keeps the plan
    // intact: nothing is lost, and the new track simply goes first.
    const state = get();
    const previousQueue = state.queue;

    const queue = [mapped];
    // `extras` come straight after the track the user picked — they are
    // the tail of the same action (a radio seeded from this track, a
    // shared link's playlist).
    for (const t of extras ?? []) {
      const extra = shelfItemToTrack(t);
      if (!extra) continue;
      if (extra.videoId === mapped.videoId) continue;
      if (queue.some((q) => q.videoId === extra.videoId)) continue;
      queue.push(extra);
    }
    // The whole queue moves behind the new track, minus any duplicate
    // of it.
    for (const t of previousQueue) {
      if (t.videoId === mapped.videoId) continue;
      if (queue.some((q) => q.videoId === t.videoId)) continue;
      queue.push(t);
    }

    // Honour an active shuffle for the trailing tracks (current stays first).
    const finalQueue =
      get().shuffle && queue.length > 1
        ? [queue[0], ...fisherYates(queue.slice(1))]
        : queue;
    set({
      queue: finalQueue,
      index: 0,
      status: "loading",
      streamUrl: undefined,
      position: 0,
      duration: mapped.duration ?? 0,
      playing: true,
      error: undefined,
      queueContinuation: undefined,
      history: appendHistory(get().history, mapped),
    });
  },

  setQueue: (tracks, startIndex = 0) => {
    if (tracks.length === 0) return;
    const i = Math.max(0, Math.min(startIndex, tracks.length - 1));
    // Honour an active shuffle: keep the chosen track current and shuffle
    // the upcoming portion, matching setShuffle's semantics.
    let queue = tracks;
    if (get().shuffle) {
      queue = [...tracks.slice(0, i + 1), ...fisherYates(tracks.slice(i + 1))];
    }
    set({
      queue,
      index: i,
      status: "loading",
      streamUrl: undefined,
      position: 0,
      duration: queue[i].duration ?? 0,
      playing: true,
      error: undefined,
      queueContinuation: undefined,
      history: appendHistory(get().history, queue[i]),
    });
  },

  playShelfItems: (items, startIndex) => {
    const tracks: QueueTrack[] = [];
    for (const it of items) {
      const m = shelfItemToTrack(it);
      if (m) tracks.push(m);
    }
    if (tracks.length === 0) return;
    // If the user clicked a non-playable item, find the nearest playable one.
    const playableOffset =
      items
        .slice(0, startIndex + 1)
        .filter((i) => i.kind === "song").length - 1;
    get().setQueue(tracks, Math.max(0, playableOffset));
  },

  enqueueNext: (track) => {
    const mapped = shelfItemToTrack(track);
    if (!mapped) return;
    set((s) => {
      const next = [...s.queue];
      const insertAt = s.index < 0 ? 0 : s.index + 1;
      next.splice(insertAt, 0, mapped);
      return { queue: next };
    });
  },

  enqueueEnd: (track) => {
    const mapped = shelfItemToTrack(track);
    if (!mapped) return;
    set((s) => ({ queue: [...s.queue, mapped] }));
  },

  appendToQueue: (tracks) => {
    const mapped: QueueTrack[] = [];
    for (const t of tracks) {
      const m = shelfItemToTrack(t);
      if (m) mapped.push(m);
    }
    if (!mapped.length) return;
    set((s) => ({ queue: [...s.queue, ...mapped] }));
  },

  /**
   * Move a queue slot to a different provider.
   *
   * The slot keeps its identity — the title, the artist and its
   * position in the queue belong to the user, not to the provider —
   * but the provider and that provider's own id change, which is what
   * the audio engine watches to re-resolve the stream.
   *
   * The `videoId` changes too, and it has to: for a non-YouTube
   * provider it is the synthetic `provider_providerTrackId` form, and
   * a stale YouTube id would make the storage tab and the media
   * session describe the wrong file.
   *
   * `origin` says where the track was *found*, for the case where the
   * source that will play it is not the one the user picked it on. It
   * is what the player shows as "found on X, playing from Y", and the
   * origin's own id is what the platform's lyrics are filed under.
   *
   * `locked` marks the choice as the user's own — the source switcher
   * sets it, so the priority order will not undo the switch later.
   */
  setTrackProvider: (
    index: number,
    ref: ProviderRef,
    origin?: { discoveredOn?: ProviderId; discoveredTrackId?: string },
    locked?: boolean,
  ) => {
    // The two ids are one recording under two names, and the app needs
    // to remember that: it is what lets the track keep its platform's
    // own lyrics on either side, and what lets the source switcher
    // offer the *exact* record rather than a search result that might
    // be a cover.
    //
    // Read before the update — the slot is about to change.
    const before = get().queue[index];
    if (before) {
      rememberPlatformPair(
        {
          provider: before.provider,
          providerTrackId: before.providerTrackId,
          videoId: before.videoId,
        },
        { provider: ref.provider, providerTrackId: ref.providerTrackId },
      );
    }

    set((s) => {
      if (index < 0 || index >= s.queue.length) return s;
      const current = s.queue[index];
      const videoId =
        ref.provider === "youtube"
          ? ref.providerTrackId
          : syntheticQueueId(ref.provider, ref.providerTrackId);
      const next = s.queue.slice();
      next[index] = {
        ...current,
        videoId,
        provider: ref.provider,
        providerTrackId: ref.providerTrackId,
        // A source the user chose by hand outranks the priority order,
        // so it is marked as locked. An automatic re-resolution leaves
        // the flag alone.
        ...(locked === undefined ? {} : { sourceLocked: locked }),
        // The track is moving away from the provider it was found on,
        // so that provider's id has to be remembered: it is the key
        // the platform's own lyrics are filed under.
        ...(current.provider === ref.provider
          ? {}
          : {
              discoveredOn:
                origin?.discoveredOn ?? current.discoveredOn ?? current.provider,
              discoveredTrackId:
                origin?.discoveredTrackId ??
                current.discoveredTrackId ??
                current.providerTrackId,
            }),
      };
      const isCurrent = index === s.index;
      return {
        queue: next,
        // The current track's stream has to be re-resolved, and the
        // player has to show the track as loading rather than keep
        // playing the old provider's audio under the new label.
        ...(isCurrent
          ? { status: "loading" as LoadStatus, streamUrl: undefined }
          : {}),
      };
    });
  },

  removeAt: (i) => {
    set((s) => {
      if (i < 0 || i >= s.queue.length) return s;
      const next = s.queue.slice();
      next.splice(i, 1);
      // If we removed the current track, advance to what's now at the same
      // index (or stay if nothing left).
      let newIndex = s.index;
      if (i < s.index) newIndex = s.index - 1;
      else if (i === s.index) {
        if (next.length === 0) {
          return {
            queue: next,
            index: -1,
            playing: false,
            status: "idle",
            streamUrl: undefined,
            position: 0,
            duration: 0,
          };
        }
        newIndex = Math.min(s.index, next.length - 1);
        // Reload the new current track.
        return {
          queue: next,
          index: newIndex,
          status: "loading",
          streamUrl: undefined,
          position: 0,
          duration: next[newIndex].duration ?? 0,
          // Removing the current track moves the playhead onto a
          // different one, which starts playing — so it is a new
          // entry in the log.
          history: appendHistory(s.history, next[newIndex]),
        };
      }
      return { queue: next, index: newIndex };
    });
  },

  moveTrack: (from, to) => {
    set((s) => {
      if (from === to) return s;
      if (from < 0 || from >= s.queue.length) return s;
      if (to < 0 || to >= s.queue.length) return s;
      const next = s.queue.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      // Keep the same track current after reorder. If the active track
      // itself is the one being moved, follow it to its new position.
      // Otherwise, account for items shifting around it.
      let newIndex = s.index;
      if (from === s.index) {
        newIndex = to;
      } else if (from < s.index && to >= s.index) {
        newIndex = s.index - 1;
      } else if (from > s.index && to <= s.index) {
        newIndex = s.index + 1;
      }
      return { queue: next, index: newIndex };
    });
  },

  clearQueue: () => {
    // The queue panel's trash button. What's playing stays put, and so
    // does the history behind it: the button empties "Up next", it is
    // not a stop button. The shuffle continuation goes with the tail it
    // was feeding; auto-radio, if on, refills from the current track.
    set((s) => ({
      queue: s.index >= 0 ? s.queue.slice(0, s.index + 1) : [],
      queueContinuation: undefined,
      radioEpoch: s.radioEpoch + 1,
    }));
  },

  stopPlayback: () => {
    set({
      queue: [],
      index: -1,
      status: "idle",
      streamUrl: undefined,
      playing: false,
      position: 0,
      duration: 0,
      queueContinuation: undefined,
      // The history belongs to the account that was signed in. An
      // account switch starts a fresh session, so the old account's
      // plays do not follow the user across.
      history: [],
    });
  },

  clearHistory: () => set({ history: [] }),

  /**
   * Play a track from the history log.
   *
   * A history entry is not a queue slot — the queue has moved on since
   * it was played — so it is played the way any other track is picked:
   * it cuts in line at the front of the queue, and the queued tracks
   * stay behind it.
   */
  playFromHistory: (historyIndex: number) => {
    const track = get().history[historyIndex];
    if (!track) return;
    get().playNow(track);
  },

  setAutoRadio: (on) => set({ autoRadio: on }),

  setQueueContinuation: (token) => set({ queueContinuation: token }),

  toggle: () => {
    const { queue, playing } = get();
    if (queue.length === 0) return;
    set({ playing: !playing });
  },

  setPlaying: (playing) => set({ playing }),

  next: () => {
    const { queue, index, repeat, shuffle } = get();
    if (queue.length === 0) return;
    // Replaying the *current* slot in place: repeat-one always, and
    // repeat-all when the queue holds a single track (wrapping lands
    // back on the same index). Route both through pendingSeek so the
    // audio engine actually restarts the element — flipping status to
    // "loading" wouldn't, because its resolve effect keys on
    // [videoId, index] and neither changes here, leaving the finished
    // element paused and playback stalled on the loader.
    if (repeat === "one" || (repeat === "all" && queue.length === 1)) {
      set({ position: 0, pendingSeek: 0, playing: true });
      return;
    }
    let nextQueue = queue;
    let nextIndex = index + 1;
    if (nextIndex >= queue.length) {
      if (repeat !== "all") {
        set({ playing: false, position: 0 });
        return;
      }
      // Looping with shuffle on → reshuffle so the next pass isn't identical.
      nextQueue = shuffle && queue.length > 1 ? fisherYates(queue) : queue;
      nextIndex = 0;
    }
    const track = nextQueue[nextIndex];
    set({
      queue: nextQueue,
      index: nextIndex,
      status: "loading",
      streamUrl: undefined,
      position: 0,
      duration: track.duration ?? 0,
      playing: true,
      error: undefined,
      // A step forward is a new track starting: it goes into the
      // history log. The repeat-one case above never reaches here —
      // it replays the same slot and is not a new entry.
      history: appendHistory(get().history, track),
    });
  },

  prev: () => {
    const { queue, index, position } = get();
    if (queue.length === 0) return;
    // The Playback tab's "Back button" rule: always step back, always
    // restart, or (smart) restart once more than N seconds have played.
    // The first track can only ever rewind. Rewinding goes through
    // pendingSeek rather than status=loading so the same stream isn't
    // re-resolved and the loader doesn't flash for no reason.
    const { backButton, smartBackSeconds } = usePlaybackSettings.getState();
    const restart =
      backButton === "restart" ||
      (backButton === "smart" && position > smartBackSeconds);
    if (index <= 0 || restart) {
      if (index >= 0) set({ position: 0, pendingSeek: 0 });
      return;
    }
    const prevIndex = index - 1;
    const track = queue[prevIndex];
    set({
      index: prevIndex,
      status: "loading",
      streamUrl: undefined,
      position: 0,
      duration: track.duration ?? 0,
      playing: true,
      error: undefined,
      // Stepping back replays a track that is already in the log. The
      // log is append-only and strictly ordered, so the track is
      // appended again — the order records what happened, including
      // the jump back.
      history: appendHistory(get().history, track),
    });
  },

  goTo: (i) => {
    const { queue } = get();
    if (i < 0 || i >= queue.length) return;
    const track = queue[i];
    set({
      index: i,
      status: "loading",
      streamUrl: undefined,
      position: 0,
      duration: track.duration ?? 0,
      playing: true,
      error: undefined,
      history: appendHistory(get().history, track),
    });
  },

  setStatus: (status, error) => set({ status, error }),
  setStreamUrl: (streamUrl) => set({ streamUrl }),
  setPosition: (position) => set({ position }),
  setDuration: (duration) => set({ duration }),
  seek: (seconds) =>
    set({ pendingSeek: Math.max(0, seconds), position: seconds }),
  clearPendingSeek: () => set({ pendingSeek: undefined }),

  setVolume: (volume) =>
    set({ volume: Math.max(0, Math.min(1, volume)), muted: false }),
  toggleMute: () => set((s) => ({ muted: !s.muted })),
  setShuffle: (on) => {
    set((s) => {
      if (!on) return { shuffle: false };
      if (s.queue.length === 0) return { shuffle: true };
      // Fisher-Yates the upcoming portion. The current track stays put and
      // history is left in original playback order so prev() walks back
      // through tracks the user actually heard.
      const after = Math.max(0, s.index + 1);
      const head = s.queue.slice(0, after);
      const tail = fisherYates(s.queue.slice(after));
      return { shuffle: true, queue: [...head, ...tail] };
    });
  },
  cycleRepeat: () =>
    set((s) => ({
      repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off",
    })),
});

// Persist only in the main window. The floating window is a *mirror* of
// the main store fed by Tauri events — letting it independently rehydrate
// from localStorage would race the main side and clobber the user's real
// state with whatever was last saved before the crash.
export const usePlaybackStore = isFloatingPlayerWindow()
  ? create<PlaybackState>()(playbackStateCreator)
  : create<PlaybackState>()(
      persist(playbackStateCreator, {
        name: "ytm-playback",
        version: 1,
        // Only the user-facing settings + the queue itself are saved.
        // Volatile fields (status, streamUrl, error, pendingSeek) and
        // `playing` are reset on rehydrate so a fresh launch never
        // auto-blasts audio at you. `position` is saved too, and kept on
        // rehydrate only when "Resume where you left off" is on; the audio
        // engine seeks there once the track's metadata has loaded.
        storage: createDebouncedJSONStorage(),
        partialize: (s) => ({
          queue: compactPersistedQueue(s.queue, s.index),
          index: persistedQueueIndex(s.queue, s.index),
          shuffle: s.shuffle,
          repeat: s.repeat,
          autoRadio: s.autoRadio,
          queueContinuation: s.queueContinuation,
          volume: s.volume,
          muted: s.muted,
          position: s.position,
        }),
        onRehydrateStorage: () => (state) => {
          if (!state) return;
          state.playing = false;
          const keepPosition =
            usePlaybackSettings.getState().resumePlayback &&
            state.index >= 0 &&
            state.index < state.queue.length &&
            Number.isFinite(state.position) &&
            state.position > 0;
          if (!keepPosition) state.position = 0;
          state.duration = state.queue[state.index]?.duration ?? 0;
          state.status = "idle";
          state.streamUrl = undefined;
          state.pendingSeek = undefined;
          state.error = undefined;
        },
      }),
    );

/** Convenience selector for the currently-playing track (or undefined). */
export function currentTrack(state: PlaybackState): QueueTrack | undefined {
  if (state.index < 0 || state.index >= state.queue.length) return undefined;
  return state.queue[state.index];
}

/**
 * Floating-window remote control. The standalone player window can't
 * actually play audio (the engine lives in the main window), so its
 * copy of the store has its user-action callbacks rewritten to emit
 * Tauri events. The main window's `<FloatingPlayerSync>` listens for
 * those, dispatches them against its own (authoritative) store, and
 * the resulting state changes broadcast back as `playback:state`
 * events that overwrite the floater's local mirror.
 *
 * State-mutating actions invoked by the audio engine (`setStatus`,
 * `setPosition`, `setStreamUrl`, `setDuration`, `setPlaying`,
 * `clearPendingSeek`) are left untouched — the engine doesn't run in
 * the floater so nothing in this window ever calls them. The
 * `FloatingPlayerSyncReceiver` writes those fields directly via
 * `setState` when state events arrive.
 *
 * Some actions (`seek`, `setVolume`, `toggleMute`) also do an
 * optimistic local update so the corresponding slider/icon doesn't
 * jump back for the round-trip.
 *
 * Call this from the floating window's entrypoint module before any
 * component reads from the store. Guarded so an accidental call from
 * the main window's bundle (it statically imports the floating module)
 * is a no-op — without this guard the main window's Play/Pause button
 * would emit an unhandled event and silently do nothing.
 */
export function initFloatingPlaybackBridge(): void {
  if (!isFloatingPlayerWindow()) return;
  const sendAction = (action: Record<string, unknown>) => {
    void emit("playback:action", action);
  };
  usePlaybackStore.setState({
    toggle: () => sendAction({ type: "toggle" }),
    next: () => sendAction({ type: "next" }),
    prev: () => sendAction({ type: "prev" }),
    seek: (seconds) => {
      usePlaybackStore.setState({ position: Math.max(0, seconds) });
      sendAction({ type: "seek", seconds });
    },
    setVolume: (volume) => {
      const clamped = Math.max(0, Math.min(1, volume));
      usePlaybackStore.setState({ volume: clamped, muted: false });
      sendAction({ type: "setVolume", volume: clamped });
    },
    toggleMute: () => {
      usePlaybackStore.setState((s) => ({ muted: !s.muted }));
      sendAction({ type: "toggleMute" });
    },
    setShuffle: (on) => sendAction({ type: "setShuffle", on }),
    cycleRepeat: () => sendAction({ type: "cycleRepeat" }),
    goTo: (index) => sendAction({ type: "goTo", index }),
    removeAt: (index) => sendAction({ type: "removeAt", index }),
    moveTrack: (from, to) => sendAction({ type: "moveTrack", from, to }),
    clearQueue: () => sendAction({ type: "clearQueue" }),
    clearHistory: () => sendAction({ type: "clearHistory" }),
    playFromHistory: (historyIndex) =>
      sendAction({ type: "playFromHistory", historyIndex }),
    appendToQueue: (tracks) =>
      sendAction({ type: "appendToQueue", tracks: tracks as unknown[] }),
    setAutoRadio: (on) => sendAction({ type: "setAutoRadio", on }),
    // Queue-building actions reachable from the floater's ⋮ menu (Play,
    // Play next, Add to queue, Start radio). Without these overrides they
    // mutated only the floater's mirror store — nothing actually played and
    // the queue silently diverged until the next broadcast overwrote it.
    playNow: (track, extras) =>
      sendAction({
        type: "playNow",
        track: track as unknown,
        extras: extras as unknown,
      }),
    playShelfItems: (items, startIndex) =>
      sendAction({
        type: "playShelfItems",
        items: items as unknown[],
        startIndex,
      }),
    enqueueNext: (track) =>
      sendAction({ type: "enqueueNext", track: track as unknown }),
    enqueueEnd: (track) =>
      sendAction({ type: "enqueueEnd", track: track as unknown }),
    // The source switcher has to reach the authoritative store: the
    // floating window has no audio engine, so a local change would
    // only repaint the floater while the main window kept playing the
    // old provider's stream.
    setTrackProvider: (index, ref) =>
      sendAction({
        type: "setTrackProvider",
        index,
        provider: ref.provider,
        providerTrackId: ref.providerTrackId,
      }),
  });
}
