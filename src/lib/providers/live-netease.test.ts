import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { canonicalFromQueueTrack } from "@/lib/providers/queue";
import { compareKeys, scoreMatch } from "@/lib/providers/match";
import { toSimplified } from "@/lib/chinese";
import { NETEASE_SEARCH_LIMIT } from "@/lib/providers/adapters/netease";
import type { QueueTrack } from "@/lib/store/playback";

/**
 * Live verification of the two fixes, against the real NetEase API.
 * Skipped unless ADEPLOY_NETEASE_LIVE=1, so the suite stays offline-safe.
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
  const c = crypto.createCipheriv("aes-128-ecb", Buffer.from(EAPI_KEY), null);
  return Buffer.concat([c.update(Buffer.from(payload, "utf8")), c.final()])
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

async function neteaseSearch(query: string, limit: number) {
  const uri = "/api/search/get";
  const params = eapiEncrypt(uri, {
    s: query,
    type: 1,
    limit,
    offset: 0,
    header: DEVICE,
  });
  const res = await fetch("https://interface.music.163.com/eapi/search/get", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: "https://music.163.com/",
    },
    body: `params=${params}`,
  });
  const json = (await res.json()) as {
    result?: {
      songs?: {
        id: number;
        name: string;
        artists?: { name: string }[];
        duration?: number;
      }[];
    };
  };
  return json.result?.songs ?? [];
}

/** The app's `findMatches`, run over a live NetEase page. */
async function resolveNetease(track: QueueTrack) {
  const canonical = canonicalFromQueueTrack(track);
  const query = [
    toSimplified(canonical.title),
    ...canonical.artists.map((a) => toSimplified(a)),
  ]
    .join(" ")
    .trim();

  const songs = await neteaseSearch(query, NETEASE_SEARCH_LIMIT);
  const candidates = songs.map((s) => ({
    id: String(s.id),
    title: s.name,
    artists: (s.artists ?? []).map((a) => a.name),
    duration: s.duration ? Math.round(s.duration / 1000) : undefined,
  }));

  const scored = candidates
    .map((cand) => ({
      cand,
      score: scoreMatch(
        {
          title: cand.title,
          artists: cand.artists,
          duration: cand.duration,
        },
        {
          title: canonical.title,
          artists: canonical.artists,
          duration: canonical.duration,
        },
      ),
    }))
    .filter((x) => x.score !== null);

  scored.sort((a, b) => compareKeys(b.score!, a.score!));
  return { query, canonical, best: scored[0]?.cand ?? null };
}

const CASES: { label: string; track: QueueTrack }[] = [
  {
    label: "Best Part (feat. Daniel Caesar, Lauren Jauregui)",
    track: {
      videoId: "zNhtz0Lygik",
      title: "Best Part (feat. Daniel Caesar, Lauren Jauregui)",
      artists: [{ id: undefined, name: "Daniel Caesar" }],
      thumbnails: [],
      duration: 210,
    },
  },
  {
    label: "草蜢",
    track: {
      videoId: "F3oRObMMNx8",
      title: "草蜢",
      artists: [{ id: undefined, name: "草蜢" }],
      thumbnails: [],
      duration: 245,
    },
  },
  {
    label: "晴天 / 周杰伦",
    track: {
      videoId: "0000",
      title: "晴天",
      artists: [{ id: undefined, name: "周杰伦" }],
      thumbnails: [],
      duration: 269,
    },
  },
];

describe.skipIf(!LIVE)("live NetEase resolution after the fixes", () => {
  for (const c of CASES) {
    it(c.label, async () => {
      const { query, best } = await resolveNetease(c.track);
      console.log(
        `  ${c.label} -> query "${query}" -> ${
          best
            ? `"${best.title}" [${best.artists.join(", ")}] id=${best.id} ${best.duration}s`
            : "NO MATCH"
        }`,
      );
      expect(best).not.toBeNull();
    });
  }
});
