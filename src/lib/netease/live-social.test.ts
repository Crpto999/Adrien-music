import { describe, expect, it } from "vitest";
import crypto from "node:crypto";

/**
 * Live verification of the comments and the 百科 endpoints, against the
 * real NetEase API.
 *
 * Skipped unless ADEPLOY_NETEASE_LIVE=1, so the suite stays offline-safe.
 *
 * These are the endpoints the app cannot get wrong by accident: they
 * are private, undocumented, and each of them has a rule that is
 * silently violated when it is broken. The hot list's cursor is walked
 * by an offset that has to match the page size; the recent list is
 * walked by a cursor that has to come from the previous page; a
 * floor's first page has to ask for `-1`. Every one of those failures
 * looks like "there is nothing here" rather than like an error, so
 * they are checked against the live platform rather than assumed.
 */

const LIVE = process.env.ADEPLOY_NETEASE_LIVE === "1";

const EAPI_KEY = "e82ckenh8dichen8";
const EAPI_UID = "-36cd479b6b5-";
const EAPI_SALT = "nobody";

function eapiEncrypt(uri: string, data: unknown): string {
  const text = JSON.stringify(data);
  const digest = crypto
    .createHash("md5")
    .update(`${EAPI_SALT}${uri}use${text}md5forencrypt`)
    .digest("hex");
  const payload = `${uri}${EAPI_UID}${text}${EAPI_UID}${digest}`;
  const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(EAPI_KEY), null);
  return Buffer.concat([cipher.update(Buffer.from(payload, "utf8")), cipher.final()])
    .toString("hex")
    .toUpperCase();
}

const DEVICE = {
  os: "pc",
  appver: "3.1.17.204416",
  osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
  deviceId: "pyncm!",
  channel: "netease",
  versioncode: "140",
  mobilename: "",
  buildver: "200000000000",
  resolution: "1920x1080",
  __csrf: "",
  requestId: "1_1",
};

async function eapiPost(uri: string, data: unknown) {
  const params = eapiEncrypt(uri, { ...(data as object), header: DEVICE });
  const res = await fetch(
    `https://interface.music.163.com/eapi${uri.replace(/^\/api/, "")}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://music.163.com/",
      },
      body: `params=${params}`,
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

/** A song with plenty written under it. 晴天 / 周杰伦 — song 186016. */
const SONG_ID = "186016";

describe.skipIf(!LIVE)("netease comments (live)", () => {
  it("answers the hot list with ranked comments", async () => {
    const body = await eapiPost("/api/v2/resource/comments", {
      threadId: `R_SO_4_${SONG_ID}`,
      pageNo: 1,
      showInner: true,
      pageSize: 20,
      cursor: "normalHot#0",
      sortType: 2,
    });
    expect(body.code).toBe(200);
    const data = body.data as { comments?: unknown[]; totalCount?: number };
    expect(Array.isArray(data.comments)).toBe(true);
    expect(data.comments!.length).toBeGreaterThan(0);
    expect(data.totalCount).toBeGreaterThan(0);

    // The hot list is ranked by likes, and the first row is the most
    // liked one there is.
    const first = data.comments![0] as {
      content?: string;
      likedCount?: number;
      user?: { nickname?: string };
    };
    expect(typeof first.content).toBe("string");
    expect(first.content!.length).toBeGreaterThan(0);
    console.log(
      `[live] hot: ${data.comments!.length} comments, ${data.totalCount} total, top liked=${first.likedCount}`,
    );
  });

  it("answers the recent list, and the second page differs from the first", async () => {
    const first = await eapiPost("/api/v2/resource/comments", {
      threadId: `R_SO_4_${SONG_ID}`,
      pageNo: 1,
      showInner: true,
      pageSize: 40,
      cursor: "0",
      sortType: 3,
    });
    expect(first.code).toBe(200);
    const firstData = first.data as {
      comments?: { commentId?: number }[];
      cursor?: string;
      hasMore?: boolean;
    };
    expect(firstData.comments!.length).toBeGreaterThan(0);
    expect(typeof firstData.cursor).toBe("string");

    // The second page is asked for with the cursor the first one
    // answered with. Asking without it comes back with the page before.
    const second = await eapiPost("/api/v2/resource/comments", {
      threadId: `R_SO_4_${SONG_ID}`,
      pageNo: 2,
      showInner: true,
      pageSize: 40,
      cursor: firstData.cursor,
      sortType: 3,
    });
    const secondData = second.data as { comments?: { commentId?: number }[] };
    const firstIds = new Set(firstData.comments!.map((c) => c.commentId));
    const overlap = secondData.comments!.filter((c) =>
      firstIds.has(c.commentId),
    ).length;
    console.log(
      `[live] latest: page1=${firstData.comments!.length} page2=${secondData.comments!.length} overlap=${overlap}`,
    );
    expect(overlap).toBe(0);
  });

  it("answers a floor with the first page's time cursor at -1", async () => {
    // A comment with replies under it.
    const hot = await eapiPost("/api/v2/resource/comments", {
      threadId: `R_SO_4_${SONG_ID}`,
      pageNo: 1,
      showInner: true,
      pageSize: 20,
      cursor: "normalHot#0",
      sortType: 2,
    });
    const comments = (
      hot.data as { comments?: { commentId: number; replyCount?: number }[] }
    ).comments!;
    const withReplies = comments.find((c) => (c.replyCount ?? 0) > 0);
    expect(withReplies).toBeDefined();

    const floor = await eapiPost("/api/resource/comment/floor/get", {
      parentCommentId: withReplies!.commentId,
      threadId: `R_SO_4_${SONG_ID}`,
      time: -1,
      limit: 40,
    });
    expect(floor.code).toBe(200);
    const floorData = floor.data as {
      comments?: unknown[];
      totalCount?: number;
    };
    console.log(
      `[live] floor: ${floorData.comments?.length ?? 0} of ${floorData.totalCount ?? 0}`,
    );
    expect(floorData.totalCount).toBeGreaterThan(0);
  });
});

describe.skipIf(!LIVE)("netease wiki (live)", () => {
  it("answers the encyclopedia page with the song's own groups", async () => {
    const body = await eapiPost("/api/song/play/about/block/page", {
      songId: SONG_ID,
    });
    expect(body.code).toBe(200);
    const blocks = (body.data as { blocks?: unknown[] }).blocks!;
    const basic = blocks.find(
      (b) => (b as { code?: string }).code === "SONG_PLAY_ABOUT_SONG_BASIC",
    ) as { creatives?: { creativeType?: string }[] } | undefined;
    expect(basic).toBeDefined();
    const types = basic!.creatives!.map((c) => c.creativeType);
    console.log(`[live] wiki groups: ${types.join(", ")}`);
    expect(types).toContain("songTag");
  });

  it("answers the song detail with the album and the artist", async () => {
    const body = await eapiPost("/api/song/detail", { ids: `[${SONG_ID}]` });
    const song = (body.songs as Record<string, unknown>[])[0] as {
      name?: string;
      album?: { name?: string; publishTime?: number };
      artists?: { id: number; name: string }[];
      publishTime?: number;
    };
    expect(song.name).toBe("晴天");
    expect(song.album?.name).toBeTruthy();
    expect(song.artists?.[0]?.name).toBe("周杰伦");
    console.log(
      `[live] detail: ${song.name} / ${song.album?.name} / ${song.artists?.[0]?.name}`,
    );
  });

  it("fills in the similar songs with one batched detail call", async () => {
    // The page's block carries the ids but not the albums or the
    // lengths, and the rows need both to be matched against the other
    // platforms well.
    const page = await eapiPost("/api/song/play/about/block/page", {
      songId: SONG_ID,
    });
    const blocks = (page.data as { blocks?: unknown[] }).blocks!;
    const block = blocks.find(
      (b) => (b as { code?: string }).code === "SONG_PLAY_ABOUT_SIMILAR_SONG",
    ) as
      | {
          creatives?: {
            resources?: {
              resourceId?: string;
              uiElement?: { mainTitle?: { title?: string } };
            }[];
          }[];
        }
      | undefined;
    const resources = block!.creatives![0].resources!;
    const ids = resources.map((r) => r.resourceId!).filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);

    const detail = await eapiPost("/api/song/detail", {
      ids: `[${ids.join(",")}]`,
    });
    const songs = detail.songs as Record<string, unknown>[];
    expect(songs.length).toBe(ids.length);

    // Every row the page gave comes back with an album and a length.
    for (const song of songs) {
      const row = song as {
        id?: number;
        name?: string;
        album?: { name?: string };
        duration?: number;
        artists?: { name: string }[];
        alias?: string[];
      };
      expect(row.name).toBeTruthy();
      expect(row.album?.name).toBeTruthy();
      expect(row.duration).toBeGreaterThan(0);
      expect(row.artists?.length).toBeGreaterThan(0);
    }
    console.log(
      `[live] similar detail: ${songs.length} rows, first=${songs[0]?.name} album=${(songs[0] as { album?: { name?: string } })?.album?.name} aliases=${((songs[0] as { alias?: string[] })?.alias ?? []).join(",")}`,
    );
  });

  it("answers the artist page with a biography", async () => {
    const body = await eapiPost("/api/v1/artist/6452", {});
    expect(body.code).toBe(200);
    const artist = body.artist as {
      name?: string;
      briefDesc?: string;
      alias?: string[];
    };
    expect(artist.name).toBe("周杰伦");
    expect((artist.briefDesc ?? "").length).toBeGreaterThan(0);
    console.log(
      `[live] artist: ${artist.name}, ${artist.alias?.length ?? 0} aliases, bio ${artist.briefDesc?.length ?? 0} chars`,
    );
  });

  it("answers the similar songs out of the encyclopedia page's block", async () => {
    // Their own route answers with an empty list for this song, so
    // they are read out of the page instead.
    const route = await eapiPost("/api/v1/discovery/simiSong", {
      songid: SONG_ID,
      limit: 10,
      offset: 0,
    });
    console.log(
      `[live] simiSong route: code=${route.code} songs=${((route.songs as unknown[]) ?? []).length}`,
    );

    const body = await eapiPost("/api/song/play/about/block/page", {
      songId: SONG_ID,
    });
    const blocks = (body.data as { blocks?: unknown[] }).blocks!;
    const block = blocks.find(
      (b) => (b as { code?: string }).code === "SONG_PLAY_ABOUT_SIMILAR_SONG",
    ) as { creatives?: { resources?: { resourceId?: string; uiElement?: { mainTitle?: { title?: string }; subTitles?: { title?: string }[] } }[] }[] } | undefined;
    expect(block).toBeDefined();
    const resources = block!.creatives![0].resources!;
    expect(resources.length).toBeGreaterThan(0);
    // Each one is a song with its id, so it can be played.
    expect(typeof resources[0].resourceId).toBe("string");
    expect(resources[0].uiElement?.mainTitle?.title).toBeTruthy();
    console.log(
      `[live] similar block: ${resources.length} songs, first=${resources[0].uiElement?.mainTitle?.title} id=${resources[0].resourceId}`,
    );
  });

  it("picks the canonical artist out of the near-twins", async () => {
    const body = await eapiPost("/api/search/get", {
      s: "周杰伦",
      type: 100,
      limit: 10,
      offset: 0,
    });
    const artists =
      (body.result as { artists?: { id?: number; name?: string }[] })
        ?.artists ?? [];
    // The catalogue answers a name with a crowd of near-twins, so the
    // exact one has to be found among them.
    const exact = artists.filter((a) => a.name?.trim() === "周杰伦");
    expect(exact.length).toBeGreaterThan(0);
    console.log(
      `[live] artist candidates: ${artists.map((a) => a.name).join(" | ")}`,
    );
    console.log(`[live] canonical artist id: ${exact[0].id}`);
    expect(exact[0].id).toBe(6452);
  });

  it("carries the credits at the head and the foot of the lyric", async () => {
    const body = await eapiPost("/api/song/lyric", {
      id: SONG_ID,
      lv: -1,
      kv: -1,
      tv: -1,
    });
    const document = (body.lrc as { lyric?: string }).lyric ?? "";
    expect(document.length).toBeGreaterThan(0);
    const lines = document.split("\n").map((l) => l.trim());
    const head = lines.slice(0, 8).join("\n");
    const tail = lines.slice(-12).join("\n");
    const credits = `${head}\n${tail}`;
    const roles = ["作词", "作曲", "编曲", "制作人", "录音", "混音", "钢琴", "吉他"];
    const found = roles.filter((r) => credits.includes(r));
    console.log(`[live] credit roles: ${found.join(", ")}`);
    expect(found.length).toBeGreaterThan(0);
  });
});
