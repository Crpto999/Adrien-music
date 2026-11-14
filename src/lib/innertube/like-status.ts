import { rawNext, type YtNode } from "./shared";

/**
 * The user's rating for a single YouTube video.
 *
 * Mirrors the values InnerTube itself uses in `likeEndpoint.status`.
 */
export type LikeStatus = "LIKE" | "DISLIKE" | "INDIFFERENT";

/**
 * Reading one track's like status out of a response.
 *
 * ## Why this exists
 *
 * The app used to decide whether a heart was filled by asking "is this
 * video in the user's Liked Songs playlist?", which meant downloading
 * the *whole* playlist — 7+ continuation round-trips, hundreds of
 * kilobytes, and a cache entry too big to persist. It also could not
 * answer for a track that came from another platform at all.
 *
 * But YouTube already answers the question per track, in the response
 * it was going to send anyway. A watch response carries the viewer's
 * own rating for the video being watched, and a signed-in row's menu
 * carries the rating for that row. So the heart's state is a property
 * of the track, fetched on demand — one request for one track, no
 * library-wide state to keep in sync.
 *
 * ## The two shapes
 *
 * A **watch** response (`/next` with a videoId) puts the rating on the
 * player overlay:
 *
 *     playerOverlayRenderer.actions[0].likeButtonRenderer.likeStatus
 *
 * A **row** (a search result, a browse row) puts it in the row's menu,
 * as a toggle whose endpoint names the status the click would switch
 * *to*:
 *
 *     menu.menuRenderer.items[].toggleMenuServiceItemRenderer
 *       .defaultServiceEndpoint.likeEndpoint.status
 *
 * The row's status is the *target*, not the current state — the same
 * inversion YouTube's own clients do. "Add to liked songs" (target
 * LIKE) means the track is not liked yet; "Remove from liked songs"
 * (target INDIFFERENT) means it is.
 *
 * Both are read here, and the watch shape wins when a response carries
 * both — it names the video outright, where the row's toggle only says
 * "this row's video".
 */

/**
 * Read the rating off a watch response.
 *
 * `null` when the response does not carry one — an unsigned-in request
 * answers with an empty overlay, which is not an error and not a
 * rating.
 */
export function parseLikeStatus(json: YtNode | undefined): LikeStatus | null {
  const actions: YtNode[] =
    json?.playerOverlays?.playerOverlayRenderer?.actions ?? [];
  for (const action of actions) {
    const status = action?.likeButtonRenderer?.likeStatus;
    if (typeof status === "string") return status as LikeStatus;
  }

  // The music-video shape puts the rating inside the action bar's
  // segmented like/dislike button instead of on the overlay's actions.
  const seg =
    json?.playerOverlays?.playerOverlayRenderer?.videoActionBar
      ?.videoActionBarViewModel?.buttons?.[0]?.buttonViewModel
      ?.segmentedLikeDislikeButtonViewModel;
  const segStatus =
    seg?.likeButtonViewModel?.likeButtonViewModel?.likeStatusEntity
      ?.likeStatus;
  if (typeof segStatus === "string") return segStatus as LikeStatus;

  return null;
}

/**
 * Read the rating off a row's menu.
 *
 * The toggle's endpoint names the status a click would switch *to*, so
 * it has to be inverted to get the current state: a row offering
 * "Remove from liked songs" (target INDIFFERENT) is currently LIKE, and
 * a row offering "Add to liked songs" (target LIKE) is currently
 * INDIFFERENT.
 *
 * `null` when the row carries no like toggle at all — a signed-out
 * response offers a "Sign in" modal instead of a toggle, and a row
 * that is not a video has no rating to read.
 */
export function parseRowLikeStatus(
  row: YtNode | undefined,
): LikeStatus | null {
  const items: YtNode[] = row?.menu?.menuRenderer?.items ?? [];
  for (const item of items) {
    const toggle = item?.toggleMenuServiceItemRenderer;
    if (!toggle) continue;

    // The toggle's *default* endpoint is what a click does now. Its
    // `status` is the state the click switches to.
    const target = toggle.defaultServiceEndpoint?.likeEndpoint?.status;
    if (typeof target !== "string") continue;

    if (target === "LIKE") return "INDIFFERENT";
    if (target === "INDIFFERENT") return "LIKE";
    if (target === "DISLIKE") return "INDIFFERENT";
  }
  return null;
}

/**
 * The rating the user gave a YouTube video.
 *
 * One request, one track. `null` means YouTube did not answer with a
 * rating — the common reasons are that nobody is signed in (the
 * response is anonymous) and that the video has no rating at all.
 */
export async function fetchLikeStatus(
  videoId: string,
): Promise<LikeStatus | null> {
  if (!videoId) return null;
  const json = await rawNext({ videoId, isAudioOnly: true });
  return parseLikeStatus(json);
}
