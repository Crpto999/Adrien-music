import { invoke } from "@tauri-apps/api/core";

/**
 * The comments under a NetEase song, and the 百科 page for one.
 *
 * ## The shapes
 *
 * These are the platform's own, read by the Rust backend
 * (`src-tauri/src/netease_social.rs`) and handed over as-is. The
 * backend does the parsing because the platform's answers are a nest
 * of objects whose field names differ per endpoint, and a frontend
 * that had to know about that would be a frontend that breaks the day
 * the platform changes one of them.
 *
 * ## The two kinds of comment
 *
 * The hot ones are ranked by likes and there are only ever a handful of
 * them; the recent ones are whatever came in most recently, and they go
 * on forever. They are kept apart because they answer different
 * questions — "what did people say" and "what are people saying" — and
 * mixing them would bury the second under the first.
 */

/** One comment under a track. */
export type NeteaseComment = {
  /** The comment's own id. Used to ask for the replies under it. */
  id: number;
  /** The text. */
  content: string;
  /** The author's name. Empty for the users the platform anonymises. */
  nickname: string;
  /** The author's picture. */
  avatarUrl: string | null;
  /** How many people liked it. The hot list is ranked by this. */
  likedCount: number;
  /** When it was written, in milliseconds. */
  timeMs: number;
  /** Where the author is, as the platform reports it. */
  location: string | null;
  /** How many replies are written under this comment. */
  replyCount: number;
  /** The comment this one is a reply to, or zero when it stands alone. */
  parentCommentId: number;
};

/** A page of comments, and where the next page continues from. */
export type NeteaseCommentPage = {
  comments: NeteaseComment[];
  /** The cursor the next page is asked with. */
  cursor: string | null;
  /** Whether another page is there at all. */
  hasMore: boolean;
  /** How many comments the whole thread holds, not just this page. */
  total: number;
  /**
   * Whether the platform is refusing to be asked right now.
   *
   * A separate answer rather than an error: the platform does not
   * refuse with an HTTP status — it answers with a perfectly
   * well-formed document whose code says otherwise — and asking again
   * straight away would only make it worse.
   */
  throttled: boolean;
};

/** The replies under one comment. */
export type NeteaseReplySet = {
  replies: NeteaseComment[];
  /** How many replies the floor holds in all. */
  total: number;
  /** The time of the oldest reply seen — where the next page continues. */
  nextCursor: number | null;
  throttled: boolean;
};

/** NetEase's "by popularity" ordering — the hot comments. */
export const NETEASE_SORT_HOT = 2;

/** NetEase's "by recency" ordering — the latest comments. */
export const NETEASE_SORT_LATEST = 3;

/**
 * The comments under a song.
 *
 * The hot list is walked by an offset into its ranking, and the offset
 * is worked out from the page number — so the cursor is only needed for
 * the recent list, where the platform hands it back.
 */
export async function neteaseComments(
  songId: string,
  sortType: number,
  pageNo = 1,
  cursor?: string | null,
): Promise<NeteaseCommentPage> {
  const id = songId.trim();
  const empty: NeteaseCommentPage = {
    comments: [],
    cursor: null,
    hasMore: false,
    total: 0,
    throttled: false,
  };
  if (!id) return empty;
  try {
    const page = await invoke<NeteaseCommentPage>("netease_comments", {
      songId: id,
      sortType,
      pageNo,
      cursor: cursor ?? null,
    });
    return page ?? empty;
  } catch {
    // A failure is an empty page rather than an error: the panel says
    // "no comments" rather than showing a broken one, and the user can
    // try again.
    return empty;
  }
}

/** The replies under one comment. */
export async function neteaseCommentReplies(
  songId: string,
  parentCommentId: number,
  timeCursor?: number | null,
): Promise<NeteaseReplySet> {
  const id = songId.trim();
  const empty: NeteaseReplySet = {
    replies: [],
    total: 0,
    nextCursor: null,
    throttled: false,
  };
  if (!id) return empty;
  try {
    return (
      (await invoke<NeteaseReplySet>("netease_comment_replies", {
        songId: id,
        parentCommentId,
        timeCursor: timeCursor ?? null,
      })) ?? empty
    );
  } catch {
    return empty;
  }
}

/** What the 百科 tab knows about one recording. */
export type NeteaseSongWiki = {
  /** The genres, under 曲风. */
  styles: string[];
  /** The recommended tags, under 推荐标签. */
  tags: string[];
  /** The album the recording is on. */
  album: string | null;
  /** The language it is sung in, under 语种. */
  language: string | null;
  /** When it was released, in milliseconds. */
  releaseTimeMs: number | null;
  /** Its tempo, under BPM. */
  bpm: string | null;
  /** The instruments played on it, under 乐器. */
  instruments: string[];
  /** Who made it, under 制作. */
  producers: string[];
  /** The awards it has won, under 获奖记录. */
  awards: string[];
  /** The films and shows it appears in, under 影视节目. */
  entertainment: string[];
  /** The catalogue's id for the artist behind it. */
  artistId: string | null;
  /** The name that artist is filed under in the catalogue. */
  artistName: string | null;
  /**
   * The songs the platform says this one sounds like.
   *
   * Read out of the encyclopedia page's own block rather than from
   * their own route: the route answers with an empty list for the
   * songs that have no similar ones, and the page's block carries the
   * same songs *with their ids*, so they can be played.
   */
  similar: NeteaseSimilarSong[];
};

/** What is known about the artist behind a recording. */
export type NeteaseArtistWiki = {
  id: string;
  name: string;
  pictureUrl: string | null;
  /** Their other names — English names and nicknames. */
  aliases: string[];
  /** Their biography. */
  biography: string | null;
};

/** One of the songs NetEase says this one sounds like. */
export type NeteaseSimilarSong = {
  id: string;
  title: string;
  artists: string[];
  /** Empty for the ones read out of the encyclopedia page's block. */
  album: string | null;
  pictureUrl: string | null;
  durationMs: number;
  /**
   * The platform's other names for the recording.
   *
   * "晴天" is also "Sunny Day" on NetEase, and the alias is often the
   * name the recording is known by on the platform the user came from —
   * which is exactly what makes the row matchable against the other
   * providers.
   */
  aliases: string[];
};

/** The 百科 page of a recording. */
export async function neteaseSongWiki(
  songId: string,
): Promise<NeteaseSongWiki | null> {
  const id = songId.trim();
  if (!id) return null;
  try {
    return await invoke<NeteaseSongWiki | null>("netease_song_wiki", {
      songId: id,
    });
  } catch {
    return null;
  }
}

/**
 * The artist behind a recording, found by their *name*.
 *
 * The recording's own entry names its artist and gives them an id — but
 * that id belongs to whichever recording the platform matched, and a
 * match is a guess: a cover, a live cut or a different song entirely
 * can share a title and an artist. So the artist is looked up by the
 * name the *playing* track carries, and the recording's own id is only
 * a fallback for when the name finds nobody.
 */
export async function neteaseArtistByName(
  name: string,
): Promise<NeteaseArtistWiki | null> {
  const wanted = name.trim();
  if (!wanted) return null;
  try {
    return await invoke<NeteaseArtistWiki | null>("netease_artist_by_name", {
      name: wanted,
    });
  } catch {
    return null;
  }
}

/** The artist behind a recording, asked by their own id. */
export async function neteaseArtistWiki(
  artistId: string,
): Promise<NeteaseArtistWiki | null> {
  const id = artistId.trim();
  if (!id) return null;
  try {
    return await invoke<NeteaseArtistWiki | null>("netease_artist_wiki", {
      artistId: id,
    });
  } catch {
    return null;
  }
}
