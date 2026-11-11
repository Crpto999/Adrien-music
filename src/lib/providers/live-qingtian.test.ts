import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { compareKeys, scoreMatch } from "@/lib/providers/match";
import { toSimplified } from "@/lib/chinese";

/**
 * Live check: for 晴天 / 周杰伦, which candidate wins — and is it the
 * original recording or a cover that merely names the artist?
 */

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

describe("live: 晴天 / 周杰伦", () => {
  it("lists the accepted candidates in score order", async () => {
    const uri = "/api/search/get";
    const params = eapiEncrypt(uri, {
      s: "晴天 周杰伦",
      type: 1,
      limit: 100,
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
    const songs = json.result?.songs ?? [];
    const hint = {
      title: toSimplified("晴天"),
      artists: [toSimplified("周杰伦")],
      duration: 269,
    };

    const scored = songs
      .map((s, i) => ({
        rank: i + 1,
        id: String(s.id),
        title: s.name,
        artists: (s.artists ?? []).map((a) => a.name),
        duration: s.duration ? Math.round(s.duration / 1000) : undefined,
        score: scoreMatch(
          {
            title: s.name,
            artists: (s.artists ?? []).map((a) => a.name),
            duration: s.duration ? Math.round(s.duration / 1000) : undefined,
          },
          hint,
        ),
      }))
      .filter((x) => x.score !== null)
      .sort((a, b) => compareKeys(b.score!, a.score!));

    console.log(`  accepted: ${scored.length} of ${songs.length} rows`);
    for (const s of scored.slice(0, 8)) {
      const isOriginal =
        s.id === "186016" ||
        (s.artists.includes("周杰伦") && s.title === "晴天");
      console.log(
        `    rank ${String(s.rank).padStart(3)} score=${s.score} "${s.title}" [${s.artists.join(", ")}] ${s.duration}s id=${s.id}${isOriginal ? "   <<< THE ORIGINAL" : ""}`,
      );
    }
    expect(scored.length).toBeGreaterThan(0);
  });
});
