import { describe, expect, it } from "vitest";
import { parseLikeStatus, parseRowLikeStatus } from "./like-status";
import type { YtNode } from "./shared";

/**
 * The heart's filled state comes from YouTube's own answer about one
 * track, not from a library-wide list.
 *
 * Two shapes have to be read:
 *
 *   - a **watch** response, whose player overlay names the rating of
 *     the video outright;
 *   - a **row**, whose menu carries a *toggle* — and the toggle names
 *     the state a click would switch **to**, so it has to be inverted.
 *
 * The inversion is the part worth pinning: reading the toggle's status
 * as-is would show every liked song as unliked, and every unliked song
 * as liked.
 */

describe("parseLikeStatus", () => {
  it("reads the rating off the player overlay", () => {
    const json = {
      playerOverlays: {
        playerOverlayRenderer: {
          actions: [{ likeButtonRenderer: { likeStatus: "LIKE" } }],
        },
      },
    } as unknown as YtNode;
    expect(parseLikeStatus(json)).toBe("LIKE");
  });

  it("reads a DISLIKE rating", () => {
    const json = {
      playerOverlays: {
        playerOverlayRenderer: {
          actions: [{ likeButtonRenderer: { likeStatus: "DISLIKE" } }],
        },
      },
    } as unknown as YtNode;
    expect(parseLikeStatus(json)).toBe("DISLIKE");
  });

  it("reads the music-video action-bar shape", () => {
    const json = {
      playerOverlays: {
        playerOverlayRenderer: {
          videoActionBar: {
            videoActionBarViewModel: {
              buttons: [
                {
                  buttonViewModel: {
                    segmentedLikeDislikeButtonViewModel: {
                      likeButtonViewModel: {
                        likeButtonViewModel: {
                          likeStatusEntity: { likeStatus: "LIKE" },
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    } as unknown as YtNode;
    expect(parseLikeStatus(json)).toBe("LIKE");
  });

  it("returns null for an anonymous response", () => {
    expect(parseLikeStatus(undefined)).toBeNull();
    expect(parseLikeStatus({} as unknown as YtNode)).toBeNull();
    expect(
      parseLikeStatus({
        playerOverlays: { playerOverlayRenderer: { actions: [] } },
      } as unknown as YtNode),
    ).toBeNull();
  });
});

describe("parseRowLikeStatus", () => {
  /** A row whose menu offers a like toggle switching to `target`. */
  function rowWithToggle(target: string): YtNode {
    return {
      menu: {
        menuRenderer: {
          items: [
            {
              toggleMenuServiceItemRenderer: {
                defaultServiceEndpoint: {
                  likeEndpoint: { status: target },
                },
              },
            },
          ],
        },
      },
    } as unknown as YtNode;
  }

  it("inverts the toggle: a LIKE target means the row is not liked", () => {
    expect(parseRowLikeStatus(rowWithToggle("LIKE"))).toBe("INDIFFERENT");
  });

  it("inverts the toggle: an INDIFFERENT target means the row is liked", () => {
    expect(parseRowLikeStatus(rowWithToggle("INDIFFERENT"))).toBe("LIKE");
  });

  it("treats a DISLIKE target as not liked", () => {
    expect(parseRowLikeStatus(rowWithToggle("DISLIKE"))).toBe("INDIFFERENT");
  });

  it("returns null for a row with no like toggle", () => {
    // A signed-out response offers a "Sign in" modal instead.
    expect(parseRowLikeStatus(undefined)).toBeNull();
    expect(parseRowLikeStatus({} as unknown as YtNode)).toBeNull();
    expect(
      parseRowLikeStatus({
        menu: { menuRenderer: { items: [{ navigationEndpoint: {} }] } },
      } as unknown as YtNode),
    ).toBeNull();
  });

  it("skips menu items that carry no like endpoint", () => {
    const json = {
      menu: {
        menuRenderer: {
          items: [
            { toggleMenuServiceItemRenderer: {} },
            {
              toggleMenuServiceItemRenderer: {
                defaultServiceEndpoint: {
                  likeEndpoint: { status: "INDIFFERENT" },
                },
              },
            },
          ],
        },
      },
    } as unknown as YtNode;
    expect(parseRowLikeStatus(json)).toBe("LIKE");
  });
});
