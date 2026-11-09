import { describe, expect, it } from "vitest";
import { scoreMatch, artistsAgree } from "@/lib/providers/match";

/**
 * A reproduction of the "True Colors" failure, using the data the live
 * NetEase search actually returned.
 *
 * The YouTube track (Wiz Khalifa - Topic, video ngdQW-1gW_0):
 *   title    "True Colors (feat. Nicki Minaj)"
 *   artist   "Wiz Khalifa"          (the "- Topic" suffix stripped)
 *   duration 255 s
 *
 * The NetEase search for "True Colors (feat. Nicki Minaj) Wiz Khalifa"
 * returned, among others:
 *   28935275  True Colors (feat. Nicki Minaj)  Wiz Khalifa, Nicki Minaj  255 s
 */
describe("the True Colors match", () => {
  const hint = {
    title: "True Colors (feat. Nicki Minaj)",
    artists: ["Wiz Khalifa"],
    duration: 255,
  };
  const candidate = {
    title: "True Colors (feat. Nicki Minaj)",
    artists: ["Wiz Khalifa", "Nicki Minaj"],
    duration: 255,
  };

  it("scores the candidate", () => {
    console.log("score:", scoreMatch(candidate, hint));
    console.log("artistsAgree:", artistsAgree(candidate, hint));
    expect(scoreMatch(candidate, hint)).not.toBeNull();
  });
});
