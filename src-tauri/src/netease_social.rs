//! NetEase Cloud Music: the comments under a song, and the song's 百科.
//!
//! # What this is
//!
//! Two families of data that hang off a NetEase song id:
//!
//!   1. **The comments** — the hot ones (ranked by likes) and the most
//!      recent ones (a stream that never ends). They answer two different
//!      questions, so they are kept apart: "what did people say" and
//!      "what are people saying".
//!   2. **The 百科** — the platform's own page for a recording: its
//!      genres, its language, its tempo, its awards, its credits, the
//!      artist behind it, and the songs it sounds like.
//!
//! Both are keyed on the platform's own song id, so the caller has to
//! resolve one first. That resolution lives in the frontend and reuses
//! the app's existing matcher — see `src/lib/netease/song-id.ts`.
//!
//! # The endpoints
//!
//! Everything here goes through the eapi channel (`netease::eapi_post`),
//! which is the platform's own app API. The comments and the 百科 are
//! both *private* endpoints — they are not documented, and the browser
//! channel's equivalents either do not exist (the comment mirror is
//! gone) or are much slower. So they are implemented here, from the
//! protocol's own shape, rather than delegated to a third party.
//!
//! # Three things that are easy to get wrong
//!
//! * **The hot list is walked by an offset.** The cursor is
//!   `normalHot#n`, and `n` counts *from the top of the ranking* in
//!   steps of one page. A step that does not match the page size asks
//!   for the same page twice.
//! * **The recent list is walked by a cursor, not an offset.** The first
//!   page has to ask for `"0"`; every page after that has to ask with
//!   the cursor the previous page answered with. A page asked for
//!   without one comes back with the page before it.
//! * **A floor's first page has to ask for `-1`.** Any other value —
//!   the parent's own time, or zero — is answered with an empty floor,
//!   and an empty floor reads exactly like "nobody replied".
//!
//! These are the platform's own rules, and they are not forgiving
//! about it: the failure is silent, not an error.

use serde::Serialize;

use crate::netease::eapi_post;
use crate::proxy;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/// The comment list. One route, two orderings.
const COMMENTS_URI: &str = "/api/v2/resource/comments";
const COMMENTS_URL: &str = "https://interface.music.163.com/eapi/v2/resource/comments";

/// The replies under one comment.
const FLOOR_URI: &str = "/api/resource/comment/floor/get";
const FLOOR_URL: &str = "https://interface.music.163.com/eapi/resource/comment/floor/get";

/// The 百科 page of a recording.
const ABOUT_URI: &str = "/api/song/play/about/block/page";
const ABOUT_URL: &str = "https://interface.music.163.com/eapi/song/play/about/block/page";

/// The recording's own entry: its album, its release date, its artist.
const DETAIL_URI: &str = "/api/song/detail";
const DETAIL_URL: &str = "https://interface.music.163.com/eapi/song/detail";

/// The artist's own page: their picture, their aliases, their biography.
const ARTIST_URI_PREFIX: &str = "/api/v1/artist/";
const ARTIST_URL_PREFIX: &str = "https://interface.music.163.com/eapi/v1/artist/";

/// The catalogue's search, used to find an artist by their name.
const SEARCH_URI: &str = "/api/search/get";
const SEARCH_URL: &str = "https://interface.music.163.com/eapi/search/get";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// The thread a song's comments hang from.
const SONG_THREAD_PREFIX: &str = "R_SO_4_";

/// NetEase's "by popularity" ordering — the hot comments.
const SORT_HOT: u8 = 2;

/// NetEase's "by recency" ordering — the latest comments.
const SORT_LATEST: u8 = 3;

/// How many comments the hot list asks for at a time.
///
/// Separate from the recent list's page size because the hot list is
/// walked by a fixed step, and the step has to be the same every time
/// or the offsets stop lining up with where the previous page ended.
const HOT_PAGE_SIZE: u64 = 20;

/// How many of the ordinary comments to ask for per page.
const LATEST_PAGE_SIZE: u64 = 40;

/// How many replies to ask for under one comment.
const REPLY_LIMIT: u64 = 40;

/// How many artists to ask the catalogue for when looking one up by name.
const ARTIST_SEARCH_LIMIT: u64 = 10;

/// The block of the 百科 page that holds the song's own facts.
///
/// The page is one aggregate call: it answers with every block the page
/// is built from — the tags, the language, the tempo, the awards, the
/// sheet music, the playlists the song appears on — and the blocks are
/// read apart here rather than fetched one at a time.
const BLOCK_SONG_BASIC: &str = "SONG_PLAY_ABOUT_SONG_BASIC";

/// The block of the 百科 page that holds the similar songs.
///
/// Their own route answers with an empty list for the songs that have
/// no similar ones, so they are read out of the page instead — where
/// they carry their ids and can be played.
const BLOCK_SIMILAR_SONG: &str = "SONG_PLAY_ABOUT_SIMILAR_SONG";

/// How alike two names have to be for an artist to be taken as the one
/// that was asked for.
///
/// Lower than the song match, because a person's name is its own name:
/// there is no "cover" of an artist and no other recording of them, so
/// a partial agreement — a band and its members, a stage name and its
/// full form — is still the same person.
const ARTIST_MATCH_SCORE: i64 = 40;

/// The platform's "you are asking too often".
const THROTTLED: i64 = -6;

/// The platform's "you are being rate limited".
const RATE_LIMITED: i64 = 418;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/// One comment under a track.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseComment {
    /// The comment's own id. Used to ask for the replies under it.
    pub id: u64,
    /// The text. This is the only field that is required: a comment
    /// with no readable words is not a comment.
    pub content: String,
    /// The author's name. Empty for the users the platform anonymises.
    pub nickname: String,
    /// The author's picture.
    pub avatar_url: Option<String>,
    /// How many people liked it. The hot list is ranked by this.
    pub liked_count: u64,
    /// When it was written, in milliseconds.
    pub time_ms: u64,
    /// Where the author is, as the platform reports it.
    pub location: Option<String>,
    /// How many replies are written under this comment.
    ///
    /// The replies themselves are behind their own call, so a track with
    /// a hundred comments does not fetch a hundred sets of them.
    pub reply_count: u64,
    /// The comment this one is a reply to, or zero when it stands on
    /// its own.
    pub parent_comment_id: u64,
}

/// A page of comments, and where the next page continues from.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseCommentPage {
    /// The comments in the page.
    pub comments: Vec<NeteaseComment>,
    /// The cursor the next page is asked with.
    ///
    /// `None` for the hot list's first page, and `None` for the recent
    /// list when there is no next page.
    pub cursor: Option<String>,
    /// Whether another page is there at all.
    pub has_more: bool,
    /// How many comments the whole thread holds, not just this page.
    pub total: u64,
    /// Whether the platform is refusing to be asked right now.
    ///
    /// A separate answer rather than an error: the platform does not
    /// refuse with an HTTP status — it answers with a perfectly
    /// well-formed document whose code says otherwise — and asking
    /// again straight away would only make it worse.
    pub throttled: bool,
}

/// The replies under one comment.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseReplySet {
    /// The replies in this page.
    pub replies: Vec<NeteaseComment>,
    /// How many replies the floor holds in all.
    ///
    /// The floor reports the whole set, where the reply list itself may
    /// be a page of it. The two disagree quite often: a reply that has
    /// been deleted is still counted but is not served.
    pub total: u64,
    /// The time of the oldest reply seen — where the next page continues
    /// from.
    pub next_cursor: Option<i64>,
    /// Whether the platform is refusing to be asked right now.
    pub throttled: bool,
}

/// What the 百科 tab knows about one recording.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseSongWiki {
    /// The genres, under 曲风.
    pub styles: Vec<String>,
    /// The recommended tags, under 推荐标签.
    pub tags: Vec<String>,
    /// The album the recording is on.
    pub album: Option<String>,
    /// The language it is sung in, under 语种.
    pub language: Option<String>,
    /// When it was released, in milliseconds.
    pub release_time_ms: Option<u64>,
    /// Its tempo, under BPM.
    pub bpm: Option<String>,
    /// The instruments played on it, under 乐器.
    pub instruments: Vec<String>,
    /// Who made it, under 制作.
    pub producers: Vec<String>,
    /// The awards it has won, under 获奖记录.
    pub awards: Vec<String>,
    /// The films and shows it appears in, under 影视节目.
    pub entertainment: Vec<String>,
    /// The catalogue's id for the artist behind it.
    pub artist_id: Option<String>,
    /// The name that artist is filed under in the catalogue — which is
    /// not always the name the track that is playing carries.
    pub artist_name: Option<String>,
    /// The songs the platform says this one sounds like.
    pub similar: Vec<NeteaseSimilarSong>,
}

/// What is known about the artist behind a recording.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseArtistWiki {
    pub id: String,
    pub name: String,
    pub picture_url: Option<String>,
    /// Their other names — English names and nicknames.
    pub aliases: Vec<String>,
    /// Their biography.
    pub biography: Option<String>,
}

/// One of the songs NetEase says this one sounds like.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseSimilarSong {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub picture_url: Option<String>,
    pub duration_ms: u64,
    /// The platform's other names for the recording.
    ///
    /// These are what make the row matchable against the other
    /// platforms: NetEase files "晴天" under the alias "Sunny Day",
    /// and the alias is often the name the recording is known by
    /// elsewhere. A row without them can only be matched by its
    /// Chinese title, which is a match the other platforms cannot
    /// answer.
    pub aliases: Vec<String>,
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/// The comments under a song.
///
/// One endpoint, two orderings: `sort_type` 2 is the hot list (ranked
/// by likes) and 3 is the recent list (newest first, walked by cursor).
///
/// The account's cookie is used when there is one: the platform serves
/// the comments to a signed-out client too, but an account gets its own
/// place in the list.
#[tauri::command]
pub async fn netease_comments(
    app: tauri::AppHandle,
    song_id: String,
    sort_type: u8,
    page_no: Option<u64>,
    cursor: Option<String>,
) -> Result<NeteaseCommentPage, String> {
    let song_id = song_id.trim();
    if song_id.is_empty() {
        return Ok(NeteaseCommentPage {
            comments: Vec::new(),
            cursor: None,
            has_more: false,
            total: 0,
            throttled: false,
        });
    }
    if sort_type != SORT_HOT && sort_type != SORT_LATEST {
        return Err(format!("netease comments: unknown sort type {sort_type}"));
    }
    let page_no = page_no.unwrap_or(1).max(1);

    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;
    let cookie = crate::netease_cookie(&app).await;

    let (page_size, cursor) = if sort_type == SORT_HOT {
        // The hot list is a ranking walked by an offset into that
        // ranking, and the offset is written as `normalHot#n`. The first
        // page starts at the top; the second starts where the first
        // ended, which is where the first page's own cursor pointed.
        let cursor = match cursor {
            Some(c) => c,
            None => hot_cursor(page_no),
        };
        (HOT_PAGE_SIZE, cursor)
    } else {
        // The recent list is walked by the time of the last comment of
        // the page before. It will not answer a page without one at all
        // — it comes back with a refusal and nothing in it — so the
        // first page asks for the beginning.
        let cursor = match cursor {
            Some(c) => c,
            None => "0".to_string(),
        };
        (LATEST_PAGE_SIZE, cursor)
    };

    let body = eapi_post(
        &client,
        COMMENTS_URI,
        COMMENTS_URL,
        serde_json::json!({
            "threadId": format!("{SONG_THREAD_PREFIX}{song_id}"),
            "pageNo": page_no,
            "showInner": true,
            "pageSize": page_size,
            "cursor": cursor,
            "sortType": sort_type,
        }),
        cookie.as_deref(),
    )
    .await
    .unwrap_or(serde_json::Value::Null);

    if is_throttled(&body) {
        return Ok(NeteaseCommentPage {
            comments: Vec::new(),
            cursor: None,
            has_more: false,
            total: 0,
            throttled: true,
        });
    }

    let data = body.get("data").unwrap_or(&serde_json::Value::Null);
    let comments: Vec<NeteaseComment> = data
        .get("comments")
        .and_then(|c| c.as_array())
        .map(|arr| arr.iter().filter_map(parse_comment).collect())
        .unwrap_or_default();
    let total = data
        .get("totalCount")
        .and_then(|t| t.as_u64())
        .unwrap_or(comments.len() as u64);
    let has_more = data
        .get("hasMore")
        .and_then(|h| h.as_bool())
        .unwrap_or(false);

    // The hot list's cursor is computed rather than read: the platform
    // answers it with the same `normalHot#n` shape, but the offset is
    // the thing that has to line up with the page size, so it is
    // worked out here where the page size is.
    let next_cursor = if sort_type == SORT_HOT {
        Some(hot_cursor(page_no + 1))
    } else {
        data.get("cursor")
            .and_then(|c| c.as_str())
            .map(|c| c.to_string())
    };

    Ok(NeteaseCommentPage {
        comments,
        cursor: next_cursor,
        has_more,
        total,
        throttled: false,
    })
}

/// The replies under one comment.
///
/// A hot comment with an argument under it is two conversations, and the
/// second one is often the better read. They live behind their own call,
/// so the list of comments is not made to carry them.
#[tauri::command]
pub async fn netease_comment_replies(
    app: tauri::AppHandle,
    song_id: String,
    parent_comment_id: u64,
    time_cursor: Option<i64>,
) -> Result<NeteaseReplySet, String> {
    let song_id = song_id.trim();
    if song_id.is_empty() {
        return Ok(NeteaseReplySet {
            replies: Vec::new(),
            total: 0,
            next_cursor: None,
            throttled: false,
        });
    }

    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;
    let cookie = crate::netease_cookie(&app).await;

    // The cursor for the *first* page has to be minus one. Any other
    // value — the parent's own time, or zero — is answered with an
    // empty floor, and an empty floor reads exactly like a comment
    // nobody has replied to.
    let time = time_cursor.unwrap_or(-1);

    let body = eapi_post(
        &client,
        FLOOR_URI,
        FLOOR_URL,
        serde_json::json!({
            "parentCommentId": parent_comment_id,
            "threadId": format!("{SONG_THREAD_PREFIX}{song_id}"),
            "time": time,
            "limit": REPLY_LIMIT,
        }),
        cookie.as_deref(),
    )
    .await
    .unwrap_or(serde_json::Value::Null);

    if is_throttled(&body) {
        return Ok(NeteaseReplySet {
            replies: Vec::new(),
            total: 0,
            next_cursor: None,
            throttled: true,
        });
    }

    let data = body.get("data").unwrap_or(&serde_json::Value::Null);
    let replies: Vec<NeteaseComment> = data
        .get("comments")
        .and_then(|c| c.as_array())
        .map(|arr| arr.iter().filter_map(parse_comment).collect())
        .unwrap_or_default();
    let total = data
        .get("totalCount")
        .and_then(|t| t.as_u64())
        .unwrap_or(replies.len() as u64);

    // The oldest reply's time is where the next page continues from.
    let next_cursor = replies
        .iter()
        .map(|r| r.time_ms as i64)
        .filter(|t| *t > 0)
        .min();

    Ok(NeteaseReplySet {
        replies,
        total,
        next_cursor,
        throttled: false,
    })
}

/// The 百科 page of a recording.
///
/// Three of the facts the page shows are not in it: the album, the
/// release date and the artist. They come from the recording's own
/// entry. The credits — the instruments and who made the record — are
/// not there either: they are written at the head and the foot of the
/// lyric document, which is where the platform keeps them.
///
/// The similar songs come from the page's own block rather than from
/// their own route: the route (`/api/v1/discovery/simiSong`) answers
/// with an empty list for the songs that have no similar ones, and the
/// page's block carries the same songs *with their ids*, so they can be
/// played.
#[tauri::command]
pub async fn netease_song_wiki(
    song_id: String,
) -> Result<Option<NeteaseSongWiki>, String> {
    let song_id = song_id.trim();
    if song_id.is_empty() {
        return Ok(None);
    }

    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;

    let body = eapi_post(
        &client,
        ABOUT_URI,
        ABOUT_URL,
        serde_json::json!({ "songId": song_id }),
        None,
    )
    .await
    .unwrap_or(serde_json::Value::Null);

    let blocks: Vec<&serde_json::Value> = body
        .pointer("/data/blocks")
        .and_then(|b| b.as_array())
        .map(|arr| arr.iter().collect())
        .unwrap_or_default();

    let creatives: Vec<&serde_json::Value> = blocks
        .iter()
        .filter(|b| b.get("code").and_then(|c| c.as_str()) == Some(BLOCK_SONG_BASIC))
        .filter_map(|b| b.get("creatives"))
        .filter_map(|c| c.as_array())
        .flatten()
        .collect();

    let detail = song_detail(&client, song_id).await;
    let credits = song_credits(&client, song_id).await;

    // The similar songs come out of the page's block with their ids but
    // without their albums or their lengths. Both of those are wanted
    // for the same reason: the row has to be playable, and a row that
    // can be matched against the other platforms needs the album and
    // the duration to be matched *well*. One batched detail call fills
    // them in.
    let mut similar = similar_songs(&blocks);
    fill_similar_details(&client, &mut similar).await;

    Ok(Some(NeteaseSongWiki {
        styles: creative_names(&creatives, "songTag"),
        tags: creative_names(&creatives, "songBizTag"),
        album: detail.album,
        language: creative_value(&creatives, "language"),
        release_time_ms: detail.release_time_ms,
        bpm: creative_value(&creatives, "bpm"),
        instruments: credits.instruments,
        producers: credits.producers,
        awards: creative_names(&creatives, "songAward"),
        entertainment: creative_names(&creatives, "entertainment"),
        artist_id: detail.artist_id,
        artist_name: detail.artist_name,
        similar,
    }))
}

/// Fill in the album, the length and the aliases of the similar songs.
///
/// One call for the whole list: the catalogue's detail endpoint takes
/// the ids as an array, and asking for them one at a time would be a
/// dozen round trips for a card that is read in one glance.
///
/// The rows that the call does not answer for keep what the page gave
/// them — the page's own title and artists are already good enough to
/// play, so a missing album is a missing detail rather than a broken
/// row.
async fn fill_similar_details(
    client: &reqwest::Client,
    songs: &mut [NeteaseSimilarSong],
) {
    if songs.is_empty() {
        return;
    }
    let ids: Vec<String> = songs.iter().map(|s| s.id.clone()).collect();
    let body = eapi_post(
        client,
        DETAIL_URI,
        DETAIL_URL,
        serde_json::json!({ "ids": format!("[{}]", ids.join(",")) }),
        None,
    )
    .await
    .unwrap_or(serde_json::Value::Null);

    let Some(rows) = body.get("songs").and_then(|s| s.as_array()) else {
        return;
    };

    for row in rows {
        merge_similar_detail(songs, row);
    }
}

/// Fold one catalogue detail entry into the row it belongs to.
///
/// Split out of the batch loop so the merge is testable without a
/// network round trip: what it does is decide which of the four fields
/// the detail entry can *add* to a row the encyclopedia page gave us.
fn merge_similar_detail(songs: &mut [NeteaseSimilarSong], row: &serde_json::Value) {
    let Some(id) = row.get("id").and_then(|i| i.as_i64()).map(|i| i.to_string()) else {
        return;
    };
    let album = row
        .pointer("/album/name")
        .and_then(|n| n.as_str())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(String::from);
    let duration_ms = row.get("duration").and_then(|d| d.as_u64()).unwrap_or(0);
    let aliases = crate::netease::parse_aliases(row.get("alias"));

    // The detail entry's own artist list is the catalogue's, and it
    // is a list of *names* where the page's subtitle was a single
    // string joined with slashes ("宋祖英/郎朗/多明戈"). The
    // catalogue's list is the one the matcher wants.
    let artists: Vec<String> = row
        .get("artists")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default();

    for song in songs.iter_mut() {
        if song.id != id {
            continue;
        }
        if song.album.is_none() {
            song.album = album.clone();
        }
        if song.duration_ms == 0 && duration_ms > 0 {
            song.duration_ms = duration_ms;
        }
        if song.aliases.is_empty() {
            song.aliases = aliases.clone();
        }
        // The catalogue's artist list is authoritative: it is the
        // platform's own list of *names* for the record, where the
        // encyclopedia page had one string joined with slashes.
        if !artists.is_empty() {
            song.artists = artists.clone();
        }
        break;
    }
}

/// The artist behind a recording, asked by their own id.
///
/// The 百科 page has no artist block of its own, so the artist is asked
/// separately.
#[tauri::command]
pub async fn netease_artist_wiki(
    artist_id: String,
) -> Result<Option<NeteaseArtistWiki>, String> {
    let artist_id = artist_id.trim();
    if artist_id.is_empty() {
        return Ok(None);
    }
    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;

    let body = eapi_post(
        &client,
        &format!("{ARTIST_URI_PREFIX}{artist_id}"),
        &format!("{ARTIST_URL_PREFIX}{artist_id}"),
        serde_json::json!({}),
        None,
    )
    .await
    .unwrap_or(serde_json::Value::Null);

    Ok(parse_artist(&body, artist_id))
}

/// The artist behind a recording, found by their *name*.
///
/// The recording's own entry names its artist and gives them an id — but
/// that id belongs to whichever recording the platform matched, and a
/// match is a guess: a cover, a live cut or a different song entirely
/// can share a title and an artist. So when the artist card is about
/// the track that is actually playing, the artist is looked up by the
/// name that track carries, and the recording's own id is only a
/// fallback for when the name finds nobody.
///
/// The search is only used to find *who* it is — its id. The card itself
/// is then read from the artist's own route, because the search's own
/// entries carry no biography.
#[tauri::command]
pub async fn netease_artist_by_name(
    name: String,
) -> Result<Option<NeteaseArtistWiki>, String> {
    let wanted = name.trim();
    if wanted.is_empty() {
        return Ok(None);
    }
    let client = proxy::build_client(reqwest::Client::builder())
        .map_err(|e| format!("netease client: {e}"))?;

    let body = eapi_post(
        &client,
        SEARCH_URI,
        SEARCH_URL,
        serde_json::json!({
            "s": wanted,
            "type": 100,
            "limit": ARTIST_SEARCH_LIMIT,
            "offset": 0,
        }),
        None,
    )
    .await
    .unwrap_or(serde_json::Value::Null);

    let artists = body
        .pointer("/result/artists")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();

    // The catalogue answers a name with a crowd of near-twins: asking
    // for 周杰伦 returns 周杰伦, 周杰伦♚ and 周杰伦jay, each of them a
    // real (if marginal) artist page. So the row is picked by *how
    // exactly* it agrees with the name asked for, and — among rows that
    // agree equally — by the lowest id, because the canonical artist
    // page is the one the catalogue filed first.
    //
    // The name is compared without case, so an English name matches in
    // any spelling of its case.
    let mut best: Option<(i64, i64, &serde_json::Value)> = None;
    for artist in artists.iter() {
        let artist_name = artist.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let score = name_similarity(artist_name, wanted);
        if score < ARTIST_MATCH_SCORE {
            continue;
        }
        let id = artist
            .get("id")
            .and_then(|i| i.as_i64())
            .unwrap_or(i64::MAX);
        let better = match best {
            None => true,
            // A closer name wins; a tie goes to the lower id.
            Some((best_score, best_id, _)) => {
                score > best_score || (score == best_score && id < best_id)
            }
        };
        if better {
            best = Some((score, id, artist));
        }
    }

    let Some((_, _, artist)) = best else {
        return Ok(None);
    };
    let id = artist
        .get("id")
        .and_then(|i| i.as_i64())
        .map(|i| i.to_string())
        .or_else(|| artist.get("id").and_then(|i| i.as_str()).map(String::from))
        .ok_or("netease artist search: the artist row has no id")?;

    // The search found the artist; their own page holds the biography.
    // A page that cannot be read is not a reason to lose the card: the
    // search's own entry already names the artist and carries their
    // picture, so it can stand in for the biography that is missing.
    let page = eapi_post(
        &client,
        &format!("{ARTIST_URI_PREFIX}{id}"),
        &format!("{ARTIST_URL_PREFIX}{id}"),
        serde_json::json!({}),
        None,
    )
    .await
    .unwrap_or(serde_json::Value::Null);

    Ok(parse_artist(&page, &id).or_else(|| {
        Some(NeteaseArtistWiki {
            id: id.clone(),
            name: artist
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string(),
            picture_url: artist
                .get("picUrl")
                .and_then(|p| p.as_str())
                .map(crate::cover_url::to_https),
            aliases: string_list(artist.get("alias")),
            biography: None,
        })
    }))
}

/// The songs NetEase says this one sounds like.
///
/// Read out of the 百科 page's own similar-songs block rather than from
/// their own route (`/api/v1/discovery/simiSong`).
///
/// The route answers with an empty list for the songs that have no
/// similar ones — measured against the live platform, 晴天 (186016)
/// comes back with `{"songs":[],"code":200}` — and the page's block
/// carries the same songs *with their ids*, so they can be played.
///
/// The block's own shape is a list of resources, each of which is a
/// song: its id is the resource's id, its title the main title, its
/// artists the first subtitle, and its picture the first image.
fn similar_songs(blocks: &[&serde_json::Value]) -> Vec<NeteaseSimilarSong> {
    let mut out: Vec<NeteaseSimilarSong> = Vec::new();
    for block in blocks {
        if block.get("code").and_then(|c| c.as_str()) != Some(BLOCK_SIMILAR_SONG) {
            continue;
        }
        let Some(creatives) = block.get("creatives").and_then(|c| c.as_array()) else {
            continue;
        };
        for creative in creatives {
            let Some(resources) = creative.get("resources").and_then(|r| r.as_array()) else {
                continue;
            };
            for resource in resources {
                let Some(id) = resource
                    .get("resourceId")
                    .and_then(|i| i.as_str())
                    .filter(|i| !i.is_empty())
                else {
                    continue;
                };
                let title = resource
                    .pointer("/uiElement/mainTitle/title")
                    .and_then(|t| t.as_str())
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .unwrap_or_default();
                if title.is_empty() {
                    continue;
                }
                // The page's subtitle is one string joined with slashes
                // ("宋祖英/郎朗/多明戈"), and the catalogue's own list
                // of names is what the matcher compares. So the joined
                // string is split here, and the catalogue's list
                // replaces it entirely when the detail call answers.
                let artists: Vec<String> = resource
                    .pointer("/uiElement/subTitles")
                    .and_then(|s| s.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.get("title").and_then(|t| t.as_str()))
                            .flat_map(|s| split_artist_line(s))
                            .collect()
                    })
                    .unwrap_or_default();
                let picture_url = resource
                    .pointer("/uiElement/images/0/imageUrl")
                    .and_then(|p| p.as_str())
                    .map(crate::cover_url::to_https);
                out.push(NeteaseSimilarSong {
                    id: id.to_string(),
                    title: title.to_string(),
                    artists,
                    album: None,
                    picture_url,
                    duration_ms: 0,
                    aliases: Vec::new(),
                });
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Reading the answers
// ---------------------------------------------------------------------------

/// Read one comment out of the platform's shape.
///
/// The content is the only thing required: a comment with no readable
/// words is not a comment, and one whose user or avatar is missing is
/// still perfectly readable — the platform anonymises some of its users
/// and blanks others.
fn parse_comment(raw: &serde_json::Value) -> Option<NeteaseComment> {
    let content = raw
        .get("content")
        .and_then(|c| c.as_str())
        .map(str::trim)
        .filter(|c| !c.is_empty())?;
    let user = raw.get("user");
    Some(NeteaseComment {
        id: raw.get("commentId").and_then(|i| i.as_u64()).unwrap_or(0),
        content: content.to_string(),
        nickname: user
            .and_then(|u| u.get("nickname"))
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string(),
        avatar_url: user
            .and_then(|u| u.get("avatarUrl"))
            .and_then(|a| a.as_str())
            .map(crate::cover_url::to_https),
        liked_count: raw.get("likedCount").and_then(|l| l.as_u64()).unwrap_or(0),
        time_ms: raw.get("time").and_then(|t| t.as_u64()).unwrap_or(0),
        location: raw
            .pointer("/ipLocation/location")
            .and_then(|l| l.as_str())
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from),
        reply_count: raw.get("replyCount").and_then(|r| r.as_u64()).unwrap_or(0),
        parent_comment_id: raw
            .get("parentCommentId")
            .and_then(|p| p.as_u64())
            .unwrap_or(0),
    })
}

/// The recording's own entry, read once for everything it carries.
///
/// Three facts come out of it and all three are wanted by the same
/// card: the album it is on, when it was released, and who made it.
struct SongDetail {
    album: Option<String>,
    release_time_ms: Option<u64>,
    artist_id: Option<String>,
    /// The name the catalogue files the artist under.
    artist_name: Option<String>,
}

async fn song_detail(client: &reqwest::Client, song_id: &str) -> SongDetail {
    let empty = SongDetail {
        album: None,
        release_time_ms: None,
        artist_id: None,
        artist_name: None,
    };
    let body = eapi_post(
        client,
        DETAIL_URI,
        DETAIL_URL,
        serde_json::json!({ "ids": format!("[{song_id}]") }),
        None,
    )
    .await
    .unwrap_or(serde_json::Value::Null);

    let Some(song) = body
        .get("songs")
        .and_then(|s| s.as_array())
        .and_then(|a| a.first())
    else {
        return empty;
    };
    let album = song.get("album");
    // The song's own release date is often zero — the platform leaves it
    // empty for a great many tracks — and the album carries one that is
    // the same date in practice: a record is released with its album.
    let release_time_ms = song
        .get("publishTime")
        .and_then(|p| p.as_u64())
        .filter(|p| *p > 0)
        .or_else(|| {
            album
                .and_then(|a| a.get("publishTime"))
                .and_then(|p| p.as_u64())
                .filter(|p| *p > 0)
        });
    let first_artist = song
        .get("artists")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first());

    SongDetail {
        album: album
            .and_then(|a| a.get("name"))
            .and_then(|n| n.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        release_time_ms,
        artist_id: first_artist
            .and_then(|a| a.get("id"))
            .and_then(|i| i.as_i64())
            .map(|i| i.to_string()),
        artist_name: first_artist
            .and_then(|a| a.get("name"))
            .and_then(|n| n.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    }
}

/// The instruments and the makers, read out of a lyric document.
#[derive(Default)]
struct Credits {
    instruments: Vec<String>,
    producers: Vec<String>,
}

/// The credits written at the head and the foot of a song's lyric.
///
/// The platform keeps them there and nowhere else: the lines before the
/// first word are who wrote it, who composed it, who arranged it; the
/// lines after the last one are who recorded and mixed it and what was
/// played.
///
/// What falls out of that is not a fixed set of roles: the head is
/// 作词 / 作曲 / 编曲 / 制作人 and the foot is 录音 / 混音 / 母带 / 弦乐 /
/// 钢琴 and whatever else happened to be written there. So every line is
/// read for its role and its names.
async fn song_credits(client: &reqwest::Client, song_id: &str) -> Credits {
    let body = eapi_post(
        client,
        "/api/song/lyric",
        "https://interface.music.163.com/eapi/song/lyric",
        serde_json::json!({
            "id": song_id,
            "lv": -1, "kv": -1, "tv": -1,
        }),
        None,
    )
    .await
    .unwrap_or(serde_json::Value::Null);

    let Some(document) = body
        .pointer("/lrc/lyric")
        .and_then(|l| l.as_str())
    else {
        return Credits::default();
    };
    parse_credits(document)
}

/// The credit lines of a lyric document.
///
/// A credit line is a role and some names, separated by a colon. The
/// roles that name an instrument are the instruments — 弦乐, 钢琴, 吉他,
/// 贝斯, 鼓 — and everything else is somebody who made the record.
///
/// Only the head and the foot of the document are read, and only the
/// lines whose role is one the platform actually writes there are taken.
/// The words in the middle are the song, and a lyric that happens to
/// contain a colon is not a credit — which is why the role has to be one
/// this code knows rather than any line with a colon in it.
fn parse_credits(document: &str) -> Credits {
    let lines: Vec<&str> = document.lines().map(str::trim).collect();

    // The head and the foot of the document may overlap — a short lyric
    // document can be inside both windows — and a line read twice would
    // be counted twice. So the windows are read as *indices* into the
    // document and de-duplicated before anything is read off them.
    let mut wanted: Vec<usize> = (0..lines.len().min(8)).collect();
    let tail_start = lines.len().saturating_sub(12);
    for index in tail_start..lines.len() {
        if !wanted.contains(&index) {
            wanted.push(index);
        }
    }

    let mut instruments: Vec<String> = Vec::new();
    let mut producers: Vec<String> = Vec::new();
    for index in wanted {
        let text = lines[index].rsplit(']').next().unwrap_or("").trim();
        let role = text.split(':').next().unwrap_or("").trim();
        let names = text.split_once(':').map(|(_, n)| n.trim()).unwrap_or("");
        if !CREDIT_ROLES.contains(&role) || names.is_empty() {
            continue;
        }
        if INSTRUMENT_ROLES.contains(&role) {
            // The instrument itself is what the card shows; the players
            // are makers too, so they go in with the rest.
            push_unique(&mut instruments, role);
        }
        if PLACE_ROLES.contains(&role) {
            continue;
        }
        for name in names.split(CREDIT_SEPARATOR) {
            let name = name.trim();
            if !name.is_empty() {
                push_unique(&mut producers, name);
            }
        }
    }
    Credits {
        instruments,
        producers,
    }
}

/// Add a value to a list, unless it is already there.
///
/// The de-duplication is by *value* rather than by adjacency: a
/// producer who appears on two different credit lines is one person,
/// and the card should say so once.
fn push_unique(list: &mut Vec<String>, value: &str) {
    if !list.iter().any(|v| v == value) {
        list.push(value.to_string());
    }
}

/// The roles the platform writes on a credit line.
///
/// A closed list on purpose: the credit lines are read out of a lyric
/// document, and the middle of a lyric is the song itself. Any line with
/// a colon in it is not a credit — so the role has to be one this code
/// knows, or the song's own words would end up in the 制作 row.
const CREDIT_ROLES: &[&str] = &[
    "作词", "作曲", "编曲", "制作人", "制作", "出品", "监制", "录音", "混音", "母带", "母带工程师",
    "和声", "吉他", "贝斯", "鼓", "键盘", "钢琴", "弦乐", "提琴", "小提琴", "大提琴", "古筝",
    "琵琶", "二胡", "萨克斯", "长笛", "小号", "长号", "手风琴", "竖琴", "打击乐", "合成器",
    "电吉他", "木吉他", "Bass", "Drums", "Guitar", "Piano", "Violin", "Cello", "Synth",
    "Percussion", "Flute", "Saxophone", "Trumpet", "Lyrics", "Composer", "Arranger", "Producer",
    "Mixing", "Mastering", "Recording", "Vocals",
];

/// The roles that say where the record was made rather than who made it.
///
/// A studio is not a person, and putting "Greenbird St." in the 制作 row
/// would read as though a studio made the record.
const PLACE_ROLES: &[&str] = &["录音室", "OP", "SP"];

/// The roles that name an instrument rather than a person.
const INSTRUMENT_ROLES: &[&str] = &[
    "弦乐", "钢琴", "吉他", "贝斯", "鼓", "键盘", "提琴", "小提琴", "大提琴", "古筝", "琵琶",
    "二胡", "萨克斯", "长笛", "小号", "长号", "手风琴", "竖琴", "打击乐", "合成器", "电吉他",
    "木吉他", "Bass", "Drums", "Guitar", "Piano", "Violin", "Cello", "Synth", "Percussion",
    "Flute", "Saxophone", "Trumpet",
];

/// What separates several names on one credit line.
const CREDIT_SEPARATOR: &[char] = &['/', '、', ',', '，', '&'];

/// The names of the things in one group of the 百科 page.
///
/// A group whose members have no names of their own — the sheet-music
/// block, whose entries are pictures — has nothing to say here.
fn creative_names(creatives: &[&serde_json::Value], creative_type: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for creative in creatives {
        if creative.get("creativeType").and_then(|t| t.as_str()) != Some(creative_type) {
            continue;
        }
        let Some(resources) = creative.get("resources").and_then(|r| r.as_array()) else {
            continue;
        };
        for resource in resources {
            let title = resource
                .pointer("/uiElement/mainTitle/title")
                .and_then(|t| t.as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty());
            if let Some(title) = title {
                if !out.iter().any(|t| t == title) {
                    out.push(title.to_string());
                }
            }
        }
    }
    out
}

/// The single value of one group — the language, the tempo.
fn creative_value(creatives: &[&serde_json::Value], creative_type: &str) -> Option<String> {
    for creative in creatives {
        if creative.get("creativeType").and_then(|t| t.as_str()) != Some(creative_type) {
            continue;
        }
        let links = creative.pointer("/uiElement/textLinks")?.as_array()?;
        for link in links {
            if let Some(text) = link.get("text").and_then(|t| t.as_str()) {
                let text = text.trim();
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}

/// The artist's own page, read into our shape.
fn parse_artist(raw: &serde_json::Value, fallback_id: &str) -> Option<NeteaseArtistWiki> {
    let artist = raw.get("artist")?;
    let name = artist
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() && raw.get("artist").is_none() {
        return None;
    }
    Some(NeteaseArtistWiki {
        id: artist
            .get("id")
            .and_then(|i| i.as_i64())
            .map(|i| i.to_string())
            .unwrap_or_else(|| fallback_id.to_string()),
        name,
        picture_url: artist
            .get("picUrl")
            .and_then(|p| p.as_str())
            .map(crate::cover_url::to_https),
        aliases: string_list(artist.get("alias")),
        biography: artist
            .get("briefDesc")
            .and_then(|b| b.as_str())
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(String::from),
    })
}

/// A list of strings, with the blanks dropped.
fn string_list(raw: Option<&serde_json::Value>) -> Vec<String> {
    raw.and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Split a line of several artists into their separate names.
///
/// The encyclopedia page writes the artists of a song as one string
/// joined with slashes ("宋祖英/郎朗/多明戈"). The matcher compares a
/// *list* of names, so the joined string has to come apart before it
/// can be compared at all.
fn split_artist_line(line: &str) -> Vec<String> {
    line.split(['/', '、', ',', '，'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Where the hot list is at, given the page being asked for.
///
/// The hot list is a ranking walked by an offset into that ranking, and
/// the offset is written as `normalHot#n`. The first page starts at the
/// top; the second starts where the first ended.
fn hot_cursor(page_no: u64) -> String {
    if page_no <= 1 {
        "normalHot#0".to_string()
    } else {
        format!("normalHot#{}", (page_no - 1) * HOT_PAGE_SIZE)
    }
}

/// Whether an answer is the platform refusing to be asked.
///
/// The eapi channel does not refuse with an HTTP status — it answers
/// with a perfectly well-formed document whose code says otherwise. A
/// `418` is a rate limit and a `-6` is the same thing said more bluntly,
/// and both mean the answer will be the same for the next little while.
fn is_throttled(body: &serde_json::Value) -> bool {
    matches!(
        body.get("code").and_then(|c| c.as_i64()),
        Some(THROTTLED) | Some(RATE_LIMITED)
    )
}

/// How alike two names are, out of a hundred.
///
/// A cheap containment ratio: the length of the shorter name's
/// characters that the longer one holds, over the longer one's length.
/// It is not a real string distance, but it answers the one question
/// the artist lookup asks — *is this the person I was looking for?* —
/// well enough to tell "周杰倫" from "周杰倫倫" and from "林俊杰".
fn name_similarity(a: &str, b: &str) -> i64 {
    let a = a.trim();
    let b = b.trim();
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    if a.eq_ignore_ascii_case(b) {
        return 100;
    }
    let (short, long) = if a.chars().count() <= b.chars().count() {
        (a, b)
    } else {
        (b, a)
    };
    let long_chars: Vec<char> = long.chars().collect();
    let hits = short
        .chars()
        .filter(|c| long_chars.contains(c))
        .count();
    (hits as i64 * 100) / (long_chars.len().max(1) as i64)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hot_cursor_advances_by_the_page_size() {
        assert_eq!(hot_cursor(1), "normalHot#0");
        assert_eq!(hot_cursor(2), "normalHot#20");
        assert_eq!(hot_cursor(3), "normalHot#40");
    }

    #[test]
    fn a_comment_without_words_is_not_a_comment() {
        let raw = serde_json::json!({ "commentId": 1, "content": "   " });
        assert!(parse_comment(&raw).is_none());
    }

    #[test]
    fn a_comment_is_read_from_the_platforms_shape() {
        let raw = serde_json::json!({
            "commentId": 123,
            "content": "  好听  ",
            "likedCount": 42,
            "time": 1700000000000u64,
            "replyCount": 3,
            "parentCommentId": 0,
            "user": { "nickname": "小明", "avatarUrl": "http://p1.img.cdn.126.net/abc.jpg" },
            "ipLocation": { "location": "浙江" },
        });
        let comment = parse_comment(&raw).expect("parsed");
        assert_eq!(comment.id, 123);
        assert_eq!(comment.content, "好听");
        assert_eq!(comment.nickname, "小明");
        assert_eq!(comment.liked_count, 42);
        assert_eq!(comment.reply_count, 3);
        assert_eq!(comment.location.as_deref(), Some("浙江"));
        // The platform hands out avatars over plain HTTP, which the app
        // cannot load. The same picture is served over HTTPS.
        assert!(comment
            .avatar_url
            .as_deref()
            .unwrap()
            .starts_with("https://"));
    }

    #[test]
    fn a_comment_without_a_user_is_still_readable() {
        let raw = serde_json::json!({ "content": " anonymously " });
        let comment = parse_comment(&raw).expect("parsed");
        assert_eq!(comment.nickname, "");
        assert!(comment.avatar_url.is_none());
    }

    #[test]
    fn the_throttle_codes_are_recognised() {
        assert!(is_throttled(&serde_json::json!({ "code": -6 })));
        assert!(is_throttled(&serde_json::json!({ "code": 418 })));
        assert!(!is_throttled(&serde_json::json!({ "code": 200 })));
        assert!(!is_throttled(&serde_json::json!({})));
    }

    #[test]
    fn credits_are_read_only_from_the_known_roles() {
        let document = "作词 : 黄家驹\n作曲 : 黄家驹\n这是一句歌词 : 不该被读成制作人\n录音室 : Greenbird St.";
        let credits = parse_credits(document);
        assert_eq!(credits.producers, vec!["黄家驹".to_string()]);
        assert!(credits.instruments.is_empty());
    }

    #[test]
    fn a_credit_naming_an_instrument_lists_the_instrument() {
        let document = "混音 : 张亚东\n钢琴 : 郎朗";
        let credits = parse_credits(document);
        // The instrument itself is what the card shows...
        assert_eq!(credits.instruments, vec!["钢琴".to_string()]);
        // ...and the player is a maker too, so they go in with the rest.
        assert_eq!(
            credits.producers,
            vec!["张亚东".to_string(), "郎朗".to_string()]
        );
    }

    #[test]
    fn a_producer_named_on_two_lines_is_one_person() {
        let document = "作词 : 黄家驹\n作曲 : 黄家驹";
        let credits = parse_credits(document);
        assert_eq!(credits.producers, vec!["黄家驹".to_string()]);
    }

    #[test]
    fn several_names_on_one_credit_are_split() {
        let document = "制作人 : A、B, C";
        let credits = parse_credits(document);
        assert_eq!(
            credits.producers,
            vec!["A".to_string(), "B".to_string(), "C".to_string()]
        );
    }

    #[test]
    fn the_wiki_groups_are_read_apart() {
        let tag = serde_json::json!({
            "creativeType": "songTag",
            "resources": [
                { "uiElement": { "mainTitle": { "title": "流行" } } },
                { "uiElement": { "mainTitle": { "title": "抒情" } } },
            ],
        });
        let language = serde_json::json!({
            "creativeType": "language",
            "uiElement": { "textLinks": [ { "text": "国语" } ] },
        });
        let creatives = vec![&tag, &language];
        assert_eq!(creative_names(&creatives, "songTag"), vec!["流行", "抒情"]);
        assert_eq!(creative_value(&creatives, "language").as_deref(), Some("国语"));
        assert!(creative_names(&creatives, "songBizTag").is_empty());
    }

    #[test]
    fn the_same_name_scores_full_marks() {
        assert_eq!(name_similarity("周杰伦", "周杰伦"), 100);
        assert_eq!(name_similarity("周杰伦", " 周杰伦 "), 100);
    }

    #[test]
    fn a_different_name_scores_below_the_artist_threshold() {
        assert!(name_similarity("林俊杰", "周杰伦") < ARTIST_MATCH_SCORE);
    }

    #[test]
    fn a_near_twin_scores_below_the_exact_name() {
        // The catalogue answers 周杰伦 with 周杰伦♚ and 周杰伦jay. The
        // exact one has to win, and the twins have to be worse than it
        // but not so much worse that they are ruled out entirely.
        let exact = name_similarity("周杰伦", "周杰伦");
        assert_eq!(exact, 100);
        assert!(name_similarity("周杰伦♚", "周杰伦") < exact);
        assert!(name_similarity("周杰伦♚", "周杰伦") >= ARTIST_MATCH_SCORE);
    }

    #[test]
    fn an_unrelated_name_is_ruled_out() {
        assert!(name_similarity("林俊杰", "周杰伦") < ARTIST_MATCH_SCORE);
        assert!(name_similarity("何兵", "周杰伦") < ARTIST_MATCH_SCORE);
    }

    #[test]
    fn a_name_is_compared_without_its_case() {
        assert_eq!(name_similarity("jay chou", "JAY CHOU"), 100);
        assert_eq!(name_similarity("Jay Chou", "jay chou"), 100);
    }

    #[test]
    fn the_similar_songs_are_read_out_of_the_encyclopedias_block() {
        // The block's shape, measured against the live platform: each
        // resource is a song, with its id on the resource itself.
        let block = serde_json::json!({
            "code": "SONG_PLAY_ABOUT_SIMILAR_SONG",
            "creatives": [
                {
                    "resources": [
                        {
                            "resourceType": "SONG",
                            "resourceId": "288820",
                            "uiElement": {
                                "mainTitle": { "title": "结尾·友谊地久天长(Live)" },
                                "subTitles": [ { "title": "宋祖英/郎朗/多明戈" } ],
                                "images": [
                                    { "imageUrl": "http://p2.music.126.net/abc.jpg" }
                                ],
                            },
                        },
                    ],
                },
            ],
        });
        let songs = similar_songs(&[&block]);
        assert_eq!(songs.len(), 1);
        assert_eq!(songs[0].id, "288820");
        assert_eq!(songs[0].title, "结尾·友谊地久天长(Live)");
        // The page writes the artists as one joined string; the matcher
        // compares a list, so the string comes apart here.
        assert_eq!(
            songs[0].artists,
            vec!["宋祖英".to_string(), "郎朗".to_string(), "多明戈".to_string()]
        );
        // The platform hands out covers over plain HTTP, which the app
        // cannot load.
        assert!(songs[0].picture_url.as_deref().unwrap().starts_with("https://"));
    }

    #[test]
    fn a_block_that_is_not_the_similar_songs_is_not_read_as_one() {
        let block = serde_json::json!({
            "code": "SONG_PLAY_ABOUT_SONG_BASIC",
            "creatives": [
                {
                    "resources": [
                        { "resourceId": "1", "uiElement": { "mainTitle": { "title": "x" } } },
                    ],
                },
            ],
        });
        assert!(similar_songs(&[&block]).is_empty());
    }

    #[test]
    fn a_similar_song_without_a_title_is_skipped() {
        let block = serde_json::json!({
            "code": "SONG_PLAY_ABOUT_SIMILAR_SONG",
            "creatives": [
                {
                    "resources": [
                        { "resourceId": "1", "uiElement": { "mainTitle": { "title": "  " } } },
                    ],
                },
            ],
        });
        assert!(similar_songs(&[&block]).is_empty());
    }

    /// A similar song, as the encyclopedia page's block gives it: an id,
    /// a title, and the artists as one slash-joined string.
    fn page_song(id: &str) -> NeteaseSimilarSong {
        NeteaseSimilarSong {
            id: id.to_string(),
            title: "结尾·友谊地久天长(Live)".to_string(),
            artists: vec!["宋祖英/郎朗/多明戈".to_string()],
            album: None,
            picture_url: None,
            duration_ms: 0,
            aliases: Vec::new(),
        }
    }

    /// The catalogue's detail entry fills in what the page did not carry.
    ///
    /// The album and the length are what the row needs to be matched
    /// against the other platforms well, and the aliases are what make
    /// a Chinese-titled row matchable at all.
    #[test]
    fn the_catalogue_detail_fills_in_the_row() {
        let mut songs = vec![page_song("288820")];
        let row = serde_json::json!({
            "id": 288820,
            "name": "结尾·友谊地久天长(Live)",
            "artists": [
                { "id": 1, "name": "宋祖英" },
                { "id": 2, "name": "郎朗" },
                { "id": 3, "name": "多明戈" },
            ],
            "album": { "name": "宋祖英演唱会" },
            "duration": 268000,
            "alias": ["Farewell (Live)"],
        });
        merge_similar_detail(&mut songs, &row);

        assert_eq!(songs[0].album.as_deref(), Some("宋祖英演唱会"));
        assert_eq!(songs[0].duration_ms, 268000);
        assert_eq!(songs[0].aliases, vec!["Farewell (Live)"]);
    }

    /// The page's own artist string is one name where the catalogue
    /// has three, and the catalogue's list is the one the matcher
    /// compares.
    #[test]
    fn the_catalogue_artist_list_replaces_the_pages_joined_string() {
        let mut songs = vec![page_song("288820")];
        let row = serde_json::json!({
            "id": 288820,
            "artists": [
                { "id": 1, "name": "宋祖英" },
                { "id": 2, "name": "郎朗" },
            ],
            "album": { "name": "宋祖英演唱会" },
            "duration": 268000,
        });
        merge_similar_detail(&mut songs, &row);

        assert_eq!(
            songs[0].artists,
            vec!["宋祖英".to_string(), "郎朗".to_string()]
        );
    }

    /// A detail entry for a row that is not in the list changes nothing.
    #[test]
    fn a_detail_entry_for_another_row_is_ignored() {
        let mut songs = vec![page_song("288820")];
        let row = serde_json::json!({
            "id": 999,
            "album": { "name": "别的专辑" },
            "duration": 1000,
        });
        merge_similar_detail(&mut songs, &row);

        assert!(songs[0].album.is_none());
        assert_eq!(songs[0].duration_ms, 0);
    }

    /// A row that already has everything keeps what it has.
    ///
    /// The page's own title and artists are what the user is looking
    /// at, so a detail entry that disagrees must not overwrite them.
    #[test]
    fn a_filled_in_row_is_not_overwritten() {
        let mut songs = vec![page_song("288820")];
        songs[0].album = Some("原来的专辑".to_string());
        songs[0].duration_ms = 1000;
        let row = serde_json::json!({
            "id": 288820,
            "album": { "name": "别的专辑" },
            "duration": 268000,
        });
        merge_similar_detail(&mut songs, &row);

        assert_eq!(songs[0].album.as_deref(), Some("原来的专辑"));
        assert_eq!(songs[0].duration_ms, 1000);
    }
}
