import type { Shelf, SearchResults, ShelfItem, TopResultAction } from "./types";
import {
  collectShelfNodes,
  mapResponsiveListItem,
  mapShelfWrapper,
  pageTypeToKind,
  rawSearch,
  readRuns,
  readThumbnails,
  type YtNode,
} from "./shared";
import { SEARCH_TYPE_TOKENS } from "./locale-tokens";

/**
 * YTM search filter params.
 * (Obtained from the YTM web client; these are stable "pageParameter" strings.)
 */
export const SEARCH_FILTERS = {
  all: undefined,
  songs: "EgWKAQIIAWoQEAkQBRAKEAMQBBAQEBUQEQ==",
  albums: "EgWKAQIYAWoQEAkQBRAKEAMQBBAQEBUQEQ==",
  artists: "EgWKAQIgAWoQEAkQBRAKEAMQBBAQEBUQEQ==",
  playlists: "EgWKAQIoAWoQEAkQBRAKEAMQBBAQEBUQEQ==",
} as const;

export type SearchFilter = keyof typeof SEARCH_FILTERS;

/**
 * The "all" tab groups its flat result list into these buckets, rendered in
 * this order. Each maps to the dedicated filter tab that shows the full list.
 */
export type SearchGroup = "song" | "artist" | "album" | "playlist";

const GROUP_ORDER: SearchGroup[] = [
  "song",
  "artist",
  "album",
  "playlist",
];

/**
 * Section heading per group. Translated at render time so it follows the
 * user's language; the key lives in the shared dictionary.
 */
const GROUP_TITLE_KEY: Record<SearchGroup, string> = {
  song: "searchGroup.song",
  artist: "searchGroup.artist",
  album: "searchGroup.album",
  playlist: "searchGroup.playlist",
};

/** Group id (`all-<group>`) → the filter tab that shows its full list. */
export const GROUP_FILTER: Record<SearchGroup, SearchFilter> = {
  song: "songs",
  artist: "artists",
  album: "albums",
  playlist: "playlists",
};

// Modern YTM "all" search returns a flat, relevance-ranked list of mixed rows
// (each `musicResponsiveListItemRenderer` wrapped in its own
// `itemSectionRenderer`) rather than titled shelves. The row's *type* lives in
// the first token of its subtitle ("Song • …", "Album • …", "Artist • …").
// The token is rendered in the request's `hl`, so it is English for an
// English request and Chinese for a Chinese one ("歌曲 • …", "专辑 • …").
// `SEARCH_TYPE_TOKENS` carries both sets. Types the app has no destination
// for (Profile / Episode / Podcast) are absent from that map and get skipped.
const TOKEN_TO_GROUP: Record<string, SearchGroup> =
  SEARCH_TYPE_TOKENS as Record<string, SearchGroup>;

/** First subtitle token of a responsive row, e.g. "Song" / "Album" / "Artist". */
function subtitleToken(mrli: YtNode): string {
  const flex: YtNode[] = mrli.flexColumns ?? [];
  const node = flex[1]?.musicResponsiveListItemFlexColumnRenderer?.text;
  const firstRun = node?.runs?.[0]?.text;
  if (typeof firstRun === "string" && firstRun.trim()) return firstRun.trim();
  // Fall back to splitting the whole subtitle on the bullet separator.
  return readRuns(node).split("•")[0]?.trim() ?? "";
}

/**
 * Classify a flat "all"-tab row into a display group + normalized item.
 * Returns null for rows the app can't navigate to (profiles, episodes,
 * podcasts) or that fail to map. Exported for unit tests.
 */
export function classifyAllRow(
  mrli: YtNode,
): { group: SearchGroup; item: ShelfItem } | null {
  const group = TOKEN_TO_GROUP[subtitleToken(mrli)];
  if (!group) return null;

  const item = mapResponsiveListItem(mrli);
  if (!item) return null;

  return { group, item };
}

/**
 * Map the top-result `musicCardShelfRenderer` to the entity it promotes.
 * The card's own `title`/`subtitle`/`thumbnail` describe the entity, and its
 * `onTap` (equivalently the title run's navigationEndpoint) carries the
 * destination — a browseEndpoint for artists/albums/playlists, a watchEndpoint
 * for songs/videos. The pre-existing parser lost this because it only handled
 * the watch case, which is why an artist/album top result fell back to a
 * "Section N" label. Exported for unit tests.
 */
export function mapTopResultCard(card: YtNode): ShelfItem | null {
  const title = readRuns(card.title);
  if (!title) return null;

  const subtitle = readRuns(card.subtitle);
  const thumbnails = readThumbnails(
    card.thumbnail?.musicThumbnailRenderer?.thumbnail,
  );

  const tap = card.onTap ?? card.title?.runs?.[0]?.navigationEndpoint ?? {};
  const watchId: string | undefined = tap.watchEndpoint?.videoId;
  const browse = tap.browseEndpoint;

  if (watchId) {
    return {
      kind: "song",
      id: watchId,
      title,
      subtitle: subtitle || undefined,
      thumbnails,
    };
  }

  if (browse?.browseId) {
    const pageType: string =
      browse.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType ?? "";
    const kind = pageTypeToKind(pageType);
    if (!kind) return null;
    return {
      kind,
      id: browse.browseId,
      title,
      subtitle: subtitle || undefined,
      thumbnails,
      round: kind === "artist",
    };
  }

  return null;
}

/**
 * The top-result card's first button is its primary action: "Shuffle" for an
 * artist (a `watchPlaylistEndpoint` radio), "Play" for a song (a
 * `watchEndpoint` videoId) or an album/playlist (a `watchPlaylistEndpoint`).
 * Exported for unit tests.
 */
export function extractCardAction(card: YtNode): TopResultAction | undefined {
  const btn: YtNode | undefined = (card.buttons ?? [])[0]?.buttonRenderer;
  if (!btn) return undefined;
  const ep = btn.command ?? btn.navigationEndpoint ?? {};
  const videoId: string | undefined = ep.watchEndpoint?.videoId;
  const playlistId: string | undefined = ep.watchPlaylistEndpoint?.playlistId;
  if (!videoId && !playlistId) return undefined;
  const isShuffle =
    btn.icon?.iconType === "MUSIC_SHUFFLE" ||
    /shuffle/i.test(readRuns(btn.text));
  return {
    label: isShuffle ? "Shuffle" : "Play",
    kind: isShuffle ? "shuffle" : "play",
    videoId,
    playlistId,
  };
}

function sectionsFromResponse(json: YtNode): YtNode[] {
  const tabs: YtNode[] =
    json?.contents?.tabbedSearchResultsRenderer?.tabs ?? [];
  return (
    tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents ??
    json?.contents?.sectionListRenderer?.contents ??
    []
  );
}

/**
 * A dedicated filter tab (Songs / Artists / Albums / …) returns a single
 * `musicShelfRenderer` with up to ~20 rows. Map it straight through.
 */
function buildFilterShelves(sections: YtNode[]): Shelf[] {
  const shelves: Shelf[] = [];
  collectShelfNodes(sections).forEach((wrapper, i) => {
    const { title, items, display } = mapShelfWrapper(wrapper, i);
    if (items.length === 0) return;
    shelves.push({ id: `${title}-${i}`, title, items, display });
  });
  return shelves;
}

/** Build the grouped "all"-tab result: a top-result hero + per-type sections. */
function buildAllResults(query: string, sections: YtNode[]): SearchResults {
  const cardNode = sections.find(
    (s) => s.musicCardShelfRenderer,
  )?.musicCardShelfRenderer;
  const topResult = cardNode
    ? (mapTopResultCard(cardNode) ?? undefined)
    : undefined;
  const topResultAction = cardNode ? extractCardAction(cardNode) : undefined;

  const buckets = new Map<SearchGroup, ShelfItem[]>();
  const seen = new Set<string>();
  // Don't repeat the promoted entity inside its own section.
  if (topResult) seen.add(`${topResult.kind}:${topResult.id}`);

  for (const section of sections) {
    const contents: YtNode[] = section.itemSectionRenderer?.contents ?? [];
    for (const c of contents) {
      const mrli = c.musicResponsiveListItemRenderer;
      if (!mrli) continue;
      const classified = classifyAllRow(mrli);
      if (!classified) continue;
      const { group, item } = classified;
      const dedupKey = `${item.kind}:${item.id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const arr = buckets.get(group);
      if (arr) arr.push(item);
      else buckets.set(group, [item]);
    }
  }

  const shelves: Shelf[] = [];
  for (const group of GROUP_ORDER) {
    const items = buckets.get(group);
    if (!items || items.length === 0) continue;
      shelves.push({
        id: `all-${group}`,
        title: GROUP_TITLE_KEY[group],
        items,
        display: group === "song" ? "list" : "card",
      });
  }

  return { query, topResult, topResultAction, shelves };
}

export async function fetchSearch(
  query: string,
  filter: SearchFilter = "all",
): Promise<SearchResults> {
  if (!query.trim()) return { query, shelves: [] };

  const json = await rawSearch(query, SEARCH_FILTERS[filter]);
  const sections = sectionsFromResponse(json);

  if (filter !== "all") {
    return { query, shelves: buildFilterShelves(sections) };
  }
  return buildAllResults(query, sections);
}
