import { describe, expect, it } from "vitest";
import {
  albumAgreement,
  artistAgreement,
  compareKeys,
  creditAgreement,
  decideConfidence,
  durationAgreement,
  isCoverFallback,
  jaroWinkler,
  normalizeText,
  scoreCandidate,
  searchTitle,
  splitFeat,
  stripAnnotation,
  titleAgreement,
  titleVariants,
  versionAgreement,
  albumBase,
  ALBUM_EXACT,
  CREDIT_CAND_ONLY,
  CREDIT_NEITHER,
} from "@/lib/providers/match";
import { normalizeSong } from "@/lib/providers/match/normalize";
import type { MatchKey } from "@/lib/providers/match";

/**
 * The matcher, against the algorithm in `docs/YouTube歌曲匹配算法.md`.
 *
 * The doc is the specification: the normalisation (§4), the tiered
 * agreement measures (§6), the cascade (§7) and the gates. These
 * tests pin each of those down, so a change to the matcher that
 * departs from the doc fails here rather than in the source switcher.
 */

/** The confidence a candidate reaches against a source. */
function confidence(
  candidate: Parameters<typeof scoreCandidate>[0],
  source: Parameters<typeof scoreCandidate>[1],
  secondKey: MatchKey | null = null,
): string {
  return decideConfidence(scoreCandidate(candidate, source), secondKey);
}

/** The normalised form of a title, for the tiered measures. */
function song(title: string, artists: string[] = []) {
  return normalizeSong({ title, artists });
}

describe("§2 — the text normalisation", () => {
  it("folds the case and the fullwidth forms", () => {
    expect(normalizeText("Best Part")).toBe("best part");
    expect(normalizeText("Ｂｅｓｔ　Ｐａｒｔ")).toBe("best part");
  });

  it("folds Traditional Chinese to Simplified", () => {
    // The doc assumes both sides are Simplified; a Taiwanese upload is
    // not, and without the conversion the two sides do not compare.
    expect(normalizeText("愛你")).toBe("爱你");
    expect(normalizeText("演員")).toBe("演员");
  });

  it("folds the halfwidth katakana prolonged sound mark", () => {
    // NetEase writes 残酷な天使のテｰゼ with a halfwidth mark; YouTube
    // writes it fullwidth. NFKC folds the two.
    expect(normalizeText("残酷な天使のテｰゼ")).toBe(
      normalizeText("残酷な天使のテーゼ"),
    );
  });

  it("drops the punctuation and keeps the Chinese", () => {
    expect(normalizeText("Best Part (feat. Daniel Caesar)")).toBe(
      "best part feat daniel caesar",
    );
    expect(normalizeText("晴天（Live）")).toBe("晴天");
  });

  it("drops the noise words, whole words only", () => {
    expect(normalizeText("晴天 Official Music Video")).toBe("晴天");
    expect(normalizeText("晴天 完整版")).toBe("晴天");
    // "Living" is not the noise word "live".
    expect(normalizeText("Living On A Prayer")).toBe("living on a prayer");
  });

  it("never normalises a title to nothing", () => {
    // An empty title would compare as "matches everything", which is
    // the worst possible answer.
    expect(normalizeText("Official Audio").length).toBeGreaterThan(0);
  });

  it("splits a featuring credit out of the title", () => {
    const { coreTitle, featArtists } = splitFeat(
      "Best Part (feat. Daniel Caesar, Lauren Jauregui)",
    );
    expect(coreTitle).toBe("Best Part");
    expect(featArtists).toEqual(["Daniel Caesar", "Lauren Jauregui"]);
  });

  it("leaves a title whose bracket is not a credit alone", () => {
    // "Stay (With Me)" — the parentheses are part of the name.
    const { coreTitle, featArtists } = splitFeat("Stay (With Me)");
    expect(coreTitle).toBe("Stay (With Me)");
    expect(featArtists).toEqual([]);
  });

  it("strips a context annotation", () => {
    // The parenthetical describes where the song comes from, not what
    // it is called.
    expect(stripAnnotation("无名的人 (电影《雄狮少年》主题曲/片尾曲)")).toBe(
      "无名的人",
    );
    // A parenthetical that is part of the name stays.
    expect(stripAnnotation("Stay (With Me)")).toBe("Stay (With Me)");
  });

  it("lists every legitimate form of a title", () => {
    // The romanisation, the translation and the core all name the
    // same song, so all of them have to be tried.
    const variants = titleVariants("紳士 - Gentleman");
    expect(variants).toContain("紳士 - Gentleman");
    expect(variants).toContain("紳士");
    expect(variants).toContain("Gentleman");
  });
});

describe("§3 — the agreement measures", () => {
  it("scores identical strings as 1 and unrelated ones low", () => {
    expect(jaroWinkler("晴天", "晴天")).toBe(1);
    expect(jaroWinkler("晴天", "稻香")).toBeLessThan(0.5);
  });

  it("rewards a shared prefix", () => {
    // "Best Part" against "Best Party" share four characters.
    expect(jaroWinkler("best part", "best party")).toBeGreaterThan(0.9);
  });

  it("takes the best of a candidate's aliases", () => {
    // "晴天" is also "Sunny Day" on NetEase, and a YouTube upload
    // filed under the English name has to find it.
    const src = song("Sunny Day");
    const cand = song("晴天");
    expect(titleAgreement(src, cand, ["sunny day"])).toBe(4);
    expect(titleAgreement(src, cand)).toBeLessThan(4);
  });

  it("discounts a title that is merely contained in the other", () => {
    // "告白" is not the song "告白气球", even though Jaro-Winkler
    // alone is generous about a shared prefix.
    const short = titleAgreement(song("告白"), song("告白气球"));
    const exact = titleAgreement(song("告白气球"), song("告白气球"));
    expect(short).toBeLessThan(exact);
  });

  it("rates a title carrying the same credit above one without", () => {
    // The credit is evidence, not noise.
    const withCredit = titleAgreement(
      song("We Don't Talk Anymore (feat. Selena Gomez)"),
      song("We Don't Talk Anymore (feat. Selena Gomez)"),
    );
    const withoutCredit = titleAgreement(
      song("We Don't Talk Anymore"),
      song("We Don't Talk Anymore"),
    );
    expect(withCredit).toBeGreaterThan(withoutCredit);
  });

  it("scores the artist sets by their overlap", () => {
    expect(artistAgreement(["周杰伦"], ["周杰伦"]).score).toBe(1);
    expect(artistAgreement(["周杰伦"], ["林俊杰"]).score).toBe(0);
  });

  it("does not penalise a candidate for an extra credited artist", () => {
    // The source names one artist; the candidate names that one plus
    // the featured one. The extra credit is not a disagreement.
    expect(
      artistAgreement(["周杰伦"], ["周杰伦", "H.E.R."]).score,
    ).toBeGreaterThanOrEqual(0.85);
  });

  it("reads a contained name as the same act", () => {
    // "Taylor" inside "Taylor Swift" — related, and the containment
    // rule trusts a long contained name.
    expect(artistAgreement(["taylor"], ["taylor swift"]).score).toBeGreaterThan(
      0.5,
    );
  });

  it("cannot verify a cross-script mismatch, and does not treat it as one", () => {
    // NetEase files the same act under a different writing system and
    // carries no alias to bridge them, so the mismatch is unverifiable
    // rather than proven.
    const crossScript = artistAgreement(["yoko takahashi"], ["高橋洋子"]);
    expect(crossScript.verified).toBe(false);
    expect(crossScript.score).toBeGreaterThan(0);

    // A same-script mismatch *is* proven.
    const sameScript = artistAgreement(["周杰伦"], ["林俊杰"]);
    expect(sameScript.verified).toBe(true);
    expect(sameScript.score).toBe(0);
  });

  it("cannot let a placeholder artist veto a match", () => {
    // "Various Artists" says nothing about who performed the track.
    const generic = artistAgreement(["various artists"], ["someone else"]);
    expect(generic.verified).toBe(false);
    expect(generic.score).toBeGreaterThan(0);
  });

  it("scores the duration by tier", () => {
    expect(durationAgreement(269, 269)).toBe(5);
    expect(durationAgreement(269, 270.5)).toBe(5);
    expect(durationAgreement(269, 272)).toBe(4);
    expect(durationAgreement(269, 275)).toBe(3);
    expect(durationAgreement(269, 279)).toBe(2);
    expect(durationAgreement(269, 285)).toBe(1);
    expect(durationAgreement(269, 300)).toBe(0);
  });

  it("scores an unknown duration as no evidence", () => {
    // Migu's search endpoint reports no length at all, so there is
    // nothing to agree with — and nothing to contradict either.
    expect(durationAgreement(269, undefined)).toBe(0);
    expect(durationAgreement(undefined, 269)).toBe(0);
  });

  it("scores the album by tier", () => {
    expect(albumAgreement(null, "叶惠美")).toBe(1);
    expect(albumAgreement("叶惠美", "叶惠美")).toBe(5);
    // "Soft Spot" inside "Soft Spot (Alternate Versions)".
    expect(albumAgreement("soft spot", "soft spot alternate versions")).toBe(4);
  });

  it("discounts a version marker rather than vetoing it", () => {
    // "Beaté (Piano)" is the platform's *only* recording of "Beaté",
    // so a version marker must never eliminate a candidate.
    const mismatch = versionAgreement([], ["piano"]);
    const match = versionAgreement(["piano"], ["piano"]);
    expect(mismatch).toBeLessThan(1);
    expect(mismatch).toBeGreaterThan(0);
    expect(match).toBe(1);
  });

  it("tells a credited release from a plain one", () => {
    expect(creditAgreement(["selena gomez"], ["selena gomez"])).toBe(4);
    expect(creditAgreement([], [])).toBe(3);
    expect(creditAgreement(["selena gomez"], [])).toBe(1);
    // A candidate that names a performer is the *more specific*
    // release, so it must not rank below one that names nobody —
    // otherwise the more specific candidate is outranked by every
    // less specific one, which is what the "True Colors" case did.
    expect(creditAgreement([], ["selena gomez"])).toBe(3);
    expect(
      creditAgreement([], ["selena gomez"]),
    ).toBeGreaterThanOrEqual(creditAgreement([], []));
  });
});

describe("§4 — the cascade", () => {
  const source = { title: "晴天", artists: ["周杰伦"], duration: 269 };

  it("calls an exact match high confidence", () => {
    expect(
      confidence({ title: "晴天", artists: ["周杰伦"], duration: 269 }, source),
    ).toBe("high");
  });

  it("rejects a different song entirely", () => {
    expect(
      confidence({ title: "稻香", artists: ["周杰伦"], duration: 269 }, source),
    ).toBe("failed");
  });

  it("rejects a cover by another artist at the matched stages", () => {
    // The cover has the same title and the same length, but a
    // different performer — so it is not the same recording.
    //
    // The performer is written in the *same* script, so the mismatch
    // is *proven* rather than unverifiable, and it is fatal.
    expect(
      confidence(
        { title: "晴天", artists: ["张碧晨"], duration: 269 },
        source,
      ),
    ).toBe("failed");
  });

  it("cannot reject a cover whose artist is written in another script", () => {
    // "RyaVocal" against "周杰伦" is, as far as the platform's
    // metadata goes, indistinguishable from "高橋洋子" against
    // "Yoko Takahashi": NetEase carries no alias to bridge the two
    // writing systems, so the mismatch is unverifiable rather than
    // proven.
    //
    // The ground truth *depends* on that leniency — 残酷な天使のテーゼ
    // is credited to 高橋洋子 on NetEase and to Yoko Takahashi on
    // YouTube, and 無名的人 to 张韶涵 and Angela Zhang. A rule that
    // rejected every cross-script mismatch would lose both of them.
    //
    // So a cross-script candidate is accepted, and the cost of that
    // leniency is that a cover credited in another script cannot be
    // told apart from a transliteration. That is a property of the
    // platforms' metadata, not of the algorithm.
    const crossScript = scoreCandidate(
      { title: "晴天", artists: ["RyaVocal"], duration: 269 },
      source,
    );
    expect(crossScript.components.artist).toBe(0.6);
    expect(crossScript.artistVerified).toBe(false);
    expect(decideConfidence(crossScript, null)).not.toBe("failed");
  });

  it("does not let the platform's ranking outvote the title", () => {
    // The candidate at rank 0 has the plain title; the one at rank 5
    // carries the credit the source names. The credit is the stronger
    // evidence, so the credited release wins even at rank 5.
    const credited = scoreCandidate(
      {
        title: "We Don't Talk Anymore (feat. Selena Gomez)",
        artists: ["Charlie Puth", "Selena Gomez"],
        duration: 218,
      },
      {
        title: "We Don't Talk Anymore (feat. Selena Gomez)",
        artists: ["Charlie Puth"],
        duration: 218,
      },
      5,
    );
    const plain = scoreCandidate(
      {
        title: "We Don't Talk Anymore",
        artists: ["Charlie Puth", "Selena Gomez"],
        duration: 218,
      },
      {
        title: "We Don't Talk Anymore (feat. Selena Gomez)",
        artists: ["Charlie Puth"],
        duration: 218,
      },
      0,
    );
    // The credited candidate's key is lexicographically greater.
    expect(credited.key[0]).toBeGreaterThan(plain.key[0]);
  });

  it("uses the platform's ranking as the last tie-breaker", () => {
    // Two candidates that agree on everything else: the one the
    // platform ranked higher wins.
    const first = scoreCandidate(
      { title: "晴天", artists: ["周杰伦"], duration: 269 },
      source,
      0,
    );
    const later = scoreCandidate(
      { title: "晴天", artists: ["周杰伦"], duration: 269 },
      source,
      30,
    );
    expect(first.key[6]).toBeGreaterThan(later.key[6]);
  });

  it("reads the rank from the candidate's own field too", () => {
    // The resolver carries the rank on the candidate rather than as an
    // argument, so the field has to reach the key. When it does not,
    // every candidate scores an identical rank component and the
    // platform's ordering stops breaking ties at all.
    const at0 = scoreCandidate(
      { title: "晴天", artists: ["周杰伦"], duration: 269, rank: 0 },
      source,
    );
    const at30 = scoreCandidate(
      { title: "晴天", artists: ["周杰伦"], duration: 269, rank: 30 },
      source,
    );
    expect(at0.key[6]).toBeGreaterThan(at30.key[6]);
    expect(compareKeys(at0.key, at30.key)).toBeGreaterThan(0);
  });

  it("keeps a cover as a fallback for playback only", () => {
    // A cover whose title and length both agree is a serviceable
    // substitute for playback — but it is never a library entry.
    // The performer is in the same script, so the mismatch is proven
    // and the candidate never reaches the confidence stages at all.
    const cover = scoreCandidate(
      { title: "晴天", artists: ["张碧晨"], duration: 269 },
      source,
    );
    expect(decideConfidence(cover, null)).toBe("failed");
    expect(isCoverFallback(cover)).toBe(true);
  });

  it("does not treat a different song as a cover", () => {
    const different = scoreCandidate(
      { title: "稻香", artists: ["周杰伦"], duration: 269 },
      source,
    );
    expect(isCoverFallback(different)).toBe(false);
  });
});

describe("the whole flow, on the case the regression test pins down", () => {
  it("splits the credit and reaches high confidence", () => {
    // The platform that filed the recording under the album credit and
    // the platform that filed it under the single credit disagree
    // about the title but agree about the artists.
    const scored = scoreCandidate(
      {
        title: "Best Part (feat. H.E.R.)",
        artists: ["Daniel Caesar", "H.E.R."],
        duration: 210,
      },
      {
        title: "Best Part (feat. Daniel Caesar, Lauren Jauregui)",
        artists: ["Daniel Caesar"],
        duration: 210,
      },
    );
    expect(scored.components.artist).toBeGreaterThanOrEqual(0.85);
    expect(decideConfidence(scored, null)).toBe("high");
  });
});

describe("the Chinese collaboration marker", () => {
  it("is read as a credit, not stripped as an annotation", () => {
    // The Chinese platforms file a collaboration as
    // "True Colors(合作音乐人:Nicki Minaj)". The annotation stripper
    // removes any bracket carrying a colon — so reading the credit
    // *after* stripping loses it, and the source silently becomes a
    // song with no credit at all.
    const split = splitFeat("True Colors(合作音乐人:Nicki Minaj)");
    expect(split.coreTitle).toBe("True Colors");
    expect(split.featArtists).toEqual(["Nicki Minaj"]);
  });

  it("keeps the credit when the title is normalised", () => {
    const song = normalizeSong({
      title: "True Colors(合作音乐人:Nicki Minaj)",
      artists: ["Wiz Khalifa"],
    });
    expect(song.featArtists).toEqual(["nicki minaj"]);
  });

  it("is searched for in the spelling the platforms use", () => {
    // The marker is not something NetEase can match: searching for
    // "True Colors(合作音乐人:Nicki Minaj)" returns a page of
    // unrelated songs, while "True Colors (feat. Nicki Minaj)" puts
    // the right record at rank 0.
    expect(searchTitle("True Colors(合作音乐人:Nicki Minaj)")).toBe(
      "True Colors (feat. Nicki Minaj)",
    );
  });

  it("does not rank a credited candidate below one with no credit", () => {
    // The credit tier compared lexicographically, and the "only the
    // candidate names a performer" tier sat *below* "neither names
    // one" — so a source that had lost its credit ranked every
    // creditless cover above the correct release.
    expect(CREDIT_CAND_ONLY).toBeGreaterThanOrEqual(CREDIT_NEITHER);
  });
});

describe("the album's edition qualifier", () => {
  it("does not make a deluxe edition a different album", () => {
    // "Blacc Hollywood" and "Blacc Hollywood (Deluxe)" are the same
    // album with more tracks, and the recording on the two is the
    // same file — the platforms give them the same length to the
    // millisecond. So the qualifier must not decide which release
    // wins.
    expect(normalizeSong({ title: "x", album: "Blacc Hollywood" }).album).toBe(
      normalizeSong({ title: "x", album: "Blacc Hollywood (Deluxe)" }).album,
    );
    expect(
      albumAgreement(
        normalizeSong({ title: "x", album: "Blacc Hollywood" }).album,
        normalizeSong({ title: "x", album: "Blacc Hollywood (Deluxe)" }).album,
      ),
    ).toBe(ALBUM_EXACT);
  });

  it("leaves an album whose parenthetical is part of its name alone", () => {
    // Only a *known* edition word is removed. An unknown parenthetical
    // is part of the name ("Flower Of Scotland: Timeless Classics
    // from the Land of the Brave" is not an edition of anything).
    expect(
      albumBase("Flower Of Scotland: Timeless Classics from the Land of the Brave"),
    ).toBe("Flower Of Scotland: Timeless Classics from the Land of the Brave");
    expect(albumBase("True Colors (Deluxe)")).toBe("True Colors");
    expect(albumBase("True Colors - Expanded Edition")).toBe("True Colors");
  });
});

describe("the cache", () => {
  it("returns the same candidates for the same query", async () => {
    const { clearMatchCache, matchCacheKey, withMatchCache } = await import(
      "@/lib/providers/match/cache"
    );
    clearMatchCache();

    const source = { title: "晴天", artists: ["周杰伦"], duration: 269 };
    const key = matchCacheKey(source);

    let calls = 0;
    const search = async () => {
      calls++;
      return ["candidate"];
    };

    expect(await withMatchCache(key, search)).toEqual(["candidate"]);
    expect(await withMatchCache(key, search)).toEqual(["candidate"]);
    // The second call was answered from the cache.
    expect(calls).toBe(1);
  });

  it("keys on the normalised title and artist list", async () => {
    const { clearMatchCache, matchCacheKey } = await import(
      "@/lib/providers/match/cache"
    );
    clearMatchCache();

    const a = matchCacheKey({ title: "晴天", artists: ["周杰伦"] });
    // The same song, spelled differently — the key must not differ.
    const b = matchCacheKey({
      title: "晴天 (Official Music Video)",
      artists: ["周杰倫"],
    });
    expect(a).toBe(b);
  });

  it("separates two different songs", async () => {
    const { clearMatchCache, matchCacheKey } = await import(
      "@/lib/providers/match/cache"
    );
    clearMatchCache();

    const a = matchCacheKey({ title: "晴天", artists: ["周杰伦"] });
    const b = matchCacheKey({ title: "稻香", artists: ["周杰伦"] });
    expect(a).not.toBe(b);
  });
});
