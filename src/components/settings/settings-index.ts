import type { IntegrationPage, SettingsTab } from "@/lib/store/settings-dialog";
import { translate } from "@/lib/i18n";

/** Fewest characters before the search starts ("more than 2 letters"). */
export const MIN_QUERY_LENGTH = 3;

export type SettingEntry = {
  tab: SettingsTab;
  /** i18n key of the row's title. */
  titleKey: string;
  /** i18n key of the row's description. */
  descriptionKey: string;
  /** Extra words people might type that the row's own text does not contain. */
  keywords?: string;
  /** Integrations only: the drill-in page the row lives on. */
  page?: IntegrationPage;
  /** Stable DOM id the row carries (`data-setting`). */
  id: string;
};

/**
 * Everything the search can find. The tabs render their own rows, so this
 * is a hand-kept mirror of their titles and descriptions; the test next to
 * it fails when a row is added or renamed without updating this list.
 *
 * Titles and descriptions live in the translation dictionary, so the index
 * stores *keys* and resolves them against the active locale. The `id` is a
 * hand-written slug rather than a derived one: it has to stay stable
 * across a language change, because it is the scroll target the search
 * jumps to.
 */
export const SETTINGS_INDEX: SettingEntry[] = [
  // General
  {
    tab: "general",
    titleKey: "settings.general.launchAtStartup",
    descriptionKey: "settings.general.launchAtStartupDesc",
    id: "launch-at-startup",
    keywords: "autostart boot login",
  },
  {
    tab: "general",
    titleKey: "settings.general.playbackNotifications",
    descriptionKey: "settings.general.playbackNotificationsDesc",
    id: "playback-notifications",
    keywords: "toast alert popup",
  },
  {
    tab: "general",
    titleKey: "settings.general.closeToTray",
    descriptionKey: "settings.general.closeToTrayDesc",
    id: "close-to-tray",
    keywords: "menu bar minimize background quit exit",
  },
  {
    tab: "general",
    titleKey: "settings.general.automaticUpdates",
    descriptionKey: "settings.general.automaticUpdatesDesc",
    id: "automatic-updates",
    keywords: "update upgrade version",
  },
  {
    tab: "general",
    titleKey: "settings.language.title",
    descriptionKey: "settings.language.description",
    id: "language",
    keywords: "locale language chinese english i18n",
  },
  {
    tab: "general",
    titleKey: "settings.general.proxy",
    descriptionKey: "settings.general.proxyDesc",
    id: "proxy",
    keywords: "network socks http https vpn tunnel proxy 代理",
  },
  {
    tab: "general",
    titleKey: "settings.general.logPath",
    descriptionKey: "settings.general.logPathDesc",
    id: "diagnostics",
    keywords: "log diagnostics debug crash report 日志 诊断",
  },

  // Playback
  {
    tab: "playback",
    titleKey: "settings.playback.crossfade",
    descriptionKey: "settings.playback.crossfadeDesc",
    id: "crossfade",
    keywords: "transition mix blend seconds",
  },
  {
    tab: "playback",
    titleKey: "settings.playback.djBassSwap",
    descriptionKey: "settings.playback.djBassSwapDesc",
    id: "dj-bass-swap",
    keywords: "dj mix low end",
  },
  {
    tab: "playback",
    titleKey: "settings.playback.smartMixTiming",
    descriptionKey: "settings.playback.smartMixTimingDesc",
    id: "smart-mix-timing",
    keywords: "dj mix outro intro silence",
  },
  {
    tab: "playback",
    titleKey: "settings.playback.volumeNormalization",
    descriptionKey: "settings.playback.volumeNormalizationDesc",
    id: "volume-normalization",
    keywords: "loudness level volume leveling",
  },
  {
    tab: "playback",
    titleKey: "settings.playback.monoAudio",
    descriptionKey: "settings.playback.monoAudioDesc",
    id: "mono-audio",
    keywords: "stereo channels accessibility",
  },
  {
    tab: "playback",
    titleKey: "settings.playback.equalizer",
    descriptionKey: "settings.playback.equalizerDesc",
    id: "equalizer",
    keywords: "eq bass boost vocal treble late night preset bands custom",
  },
  {
    tab: "playback",
    titleKey: "settings.playback.outputDevice",
    descriptionKey: "settings.playback.outputDeviceDesc",
    id: "output-device",
    keywords: "speakers headphones audio sink soundcard",
  },
  {
    tab: "playback",
    titleKey: "settings.playback.backButton",
    descriptionKey: "settings.playback.backButtonDesc",
    id: "back-button",
    keywords: "previous skip restart rewind",
  },
  {
    tab: "playback",
    titleKey: "settings.playback.resumeWhereYouLeftOff",
    descriptionKey: "settings.playback.resumeWhereYouLeftOffDesc",
    id: "resume-where-you-left-off",
    keywords: "restore last session position",
  },
  {
    tab: "playback",
    titleKey: "settings.playback.variedRadio",
    descriptionKey: "settings.playback.variedRadioDesc",
    id: "varied-radio",
    keywords: "randomize random shuffle station variety",
  },

  // Appearance
  {
    tab: "appearance",
    titleKey: "settings.appearance.theme",
    descriptionKey: "settings.appearance.themeDesc",
    id: "theme",
    keywords: "dark light cyberpunk neon mode system colors theme",
  },
  {
    tab: "appearance",
    titleKey: "settings.appearance.ambientBackground",
    descriptionKey: "settings.appearance.ambientBackgroundDesc",
    id: "ambient-background",
    keywords: "cover colour color blur",
  },
  {
    tab: "appearance",
    titleKey: "settings.appearance.windowGlow",
    descriptionKey: "settings.appearance.windowGlowDesc",
    id: "window-glow",
    keywords: "outline border light neon",
  },
  {
    tab: "appearance",
    titleKey: "settings.appearance.glowMatchesCover",
    descriptionKey: "settings.appearance.glowMatchesCoverDesc",
    id: "glow-matches-cover",
    keywords: "colour adapt album art",
  },
  {
    tab: "appearance",
    titleKey: "settings.appearance.glowSize",
    descriptionKey: "settings.appearance.glowSizeDesc",
    id: "glow-size",
    keywords: "thickness width slider",
  },
  {
    tab: "appearance",
    titleKey: "settings.appearance.ratingButtons",
    descriptionKey: "settings.appearance.ratingButtonsDesc",
    id: "rating-buttons",
    keywords: "like dislike thumbs heart favourite favorite",
  },
  {
    tab: "appearance",
    titleKey: "settings.appearance.playerLayout",
    descriptionKey: "settings.appearance.playerLayoutDesc",
    id: "player-layout",
    keywords: "now playing card sidebar bar position",
  },
  {
    tab: "appearance",
    titleKey: "settings.appearance.fullscreenLayout",
    descriptionKey: "settings.appearance.fullscreenLayoutDesc",
    id: "fullscreen-layout",
    keywords: "immersive cover lyrics video",
  },
  {
    tab: "appearance",
    titleKey: "settings.appearance.interfaceFont",
    descriptionKey: "settings.appearance.interfaceFontDesc",
    id: "interface-font",
    keywords: "typeface text size",
  },

  // Home
  {
    tab: "home",
    titleKey: "settings.home.sectionOrder",
    descriptionKey: "settings.home.sectionOrderDesc",
    id: "section-order",
    keywords: "home page sort arrange reorder hide shield visibility 隐藏 屏蔽 顺序",
  },

  // Sources
  {
    tab: "sources",
    titleKey: "settings.providers.priority",
    descriptionKey: "settings.providers.priorityDesc",
    id: "provider-priority",
    keywords: "provider priority order source 音源 优先级 顺序 来源",
  },

  // Storage
  {
    tab: "storage",
    titleKey: "settings.storage.cacheFolder",
    descriptionKey: "settings.storage.cacheFolderDesc",
    id: "cache-folder",
    keywords: "path directory location open",
  },
  {
    tab: "storage",
    titleKey: "settings.storage.storageLimit",
    descriptionKey: "settings.storage.storageLimitDesc",
    id: "storage-limit",
    keywords: "size disk space gigabytes unlimited",
  },
  {
    tab: "storage",
    titleKey: "settings.storage.autoClean",
    descriptionKey: "settings.storage.autoCleanDesc",
    id: "auto-clean",
    keywords: "delete remove clean up cache",
  },
  {
    tab: "storage",
    titleKey: "settings.storage.coverArtCache",
    descriptionKey: "settings.storage.coverArtCacheDesc",
    id: "cover-art-cache",
    keywords: "clear delete images thumbnails",
  },

  // Integrations
  {
    tab: "integrations",
    titleKey: "settings.integrations.lastfm",
    descriptionKey: "settings.integrations.lastfmDesc",
    id: "lastfm",
    page: "lastfm",
    keywords: "scrobble scrobbling api key lastfm account",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.scrobbleTracks",
    descriptionKey: "settings.integrations.scrobbleTracksDesc",
    id: "scrobble-tracks",
    page: "lastfm",
    keywords: "scrobbling lastfm",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.loveLikedTracks",
    descriptionKey: "settings.integrations.loveLikedTracksDesc",
    id: "love-liked-tracks",
    page: "lastfm",
    keywords: "heart favourite favorite lastfm",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.netease",
    descriptionKey: "settings.integrations.neteaseDesc",
    id: "netease",
    page: "netease",
    keywords: "netease 网易云 sign in login daily recommend 推荐 会员",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.discord",
    descriptionKey: "settings.integrations.discordDesc",
    id: "discord",
    page: "discord",
    keywords: "status activity",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.activityType",
    descriptionKey: "settings.integrations.activityTypeDesc",
    id: "activity-type",
    page: "discord",
    keywords: "discord listening playing watching",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.showTrackTitle",
    descriptionKey: "settings.integrations.showTrackTitleDesc",
    id: "show-track-title",
    page: "discord",
    keywords: "discord presence",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.showArtist",
    descriptionKey: "settings.integrations.showArtistDesc",
    id: "show-artist",
    page: "discord",
    keywords: "discord presence",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.showAlbumArt",
    descriptionKey: "settings.integrations.showAlbumArtDesc",
    id: "show-album-art",
    page: "discord",
    keywords: "discord presence cover",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.showAlbumName",
    descriptionKey: "settings.integrations.showAlbumNameDesc",
    id: "show-album-name",
    page: "discord",
    keywords: "discord presence",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.showElapsedTime",
    descriptionKey: "settings.integrations.showElapsedTimeDesc",
    id: "show-elapsed-time",
    page: "discord",
    keywords: "discord presence progress",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.showListenButton",
    descriptionKey: "settings.integrations.showListenButtonDesc",
    id: "show-listen-button",
    page: "discord",
    keywords: "discord presence link",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.onlyForSongs",
    descriptionKey: "settings.integrations.onlyForSongsDesc",
    id: "only-for-songs",
    page: "discord",
    keywords: "discord presence music videos",
  },
  {
    tab: "integrations",
    titleKey: "settings.integrations.hideWhilePaused",
    descriptionKey: "settings.integrations.hideWhilePausedDesc",
    id: "hide-while-paused",
    page: "discord",
    keywords: "discord presence pause",
  },
];

/** The row's title in the active locale. */
export const settingTitle = (e: SettingEntry): string =>
  translate(e.titleKey);

/** The row's description in the active locale. */
export const settingDescription = (e: SettingEntry): string =>
  translate(e.descriptionKey);

/** The DOM id the search scrolls to. */
export const entryId = (e: SettingEntry): string => e.id;

export type SettingMatch = { entry: SettingEntry; rank: number };

/** Lower-cased words of a query. Each must occur somewhere in a row. */
export const queryTerms = (query: string): string[] =>
  query.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Rows matching `query`, best first. Matching is by letter combination, not
 * whole word ("fade" finds "Crossfade"), and every word of the query has to
 * be found in the row's title, description, keywords or tab name. A hit in
 * the title ranks above one in the description, above one in the keywords.
 * Returns nothing until the query reaches MIN_QUERY_LENGTH characters.
 *
 * The title and description are resolved against the active locale, so the
 * search matches what the user actually sees.
 */
export function searchSettings(
  query: string,
  tabLabel: (tab: SettingsTab) => string = (t) => t,
): SettingMatch[] {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];
  const terms = queryTerms(trimmed);

  const out: SettingMatch[] = [];
  SETTINGS_INDEX.forEach((entry, order) => {
    const title = settingTitle(entry).toLowerCase();
    const desc = settingDescription(entry).toLowerCase();
    const extra =
      `${entry.keywords ?? ""} ${tabLabel(entry.tab)}`.toLowerCase();
    let rank = 0;
    for (const term of terms) {
      if (title.includes(term)) rank += title.startsWith(term) ? 0 : 1;
      else if (desc.includes(term)) rank += 10;
      else if (extra.includes(term)) rank += 20;
      else return; // a term found nowhere: not a match
    }
    out.push({ entry, rank: rank * 1000 + order });
  });
  return out.sort((a, b) => a.rank - b.rank);
}
