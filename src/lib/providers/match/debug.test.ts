import { describe, expect, it } from "vitest";
import { rankCandidates } from "@/lib/providers/resolve";
import { setMatchDebugEnabled } from "@/lib/providers/match/debug";
import type { ProviderCandidate } from "@/lib/providers/types";

/**
 * The match diagnostics.
 *
 * The point of the diagnostics is that a wrong match is explainable:
 * the log has to say what was searched for, what came back, how each
 * candidate scored on each component, and what the decision was.
 */
describe("the match diagnostics", () => {
  const source = {
    title: "晴天",
    artists: ["周杰伦"],
    album: "叶惠美",
    duration: 269,
    origin: "youtube" as const,
  };

  const candidates: ProviderCandidate[] = [
    {
      provider: "netease",
      providerTrackId: "186016",
      title: "晴天",
      artists: ["周杰伦"],
      album: "叶惠美",
      duration: 269,
    },
    {
      provider: "netease",
      providerTrackId: "999",
      title: "晴天 (Live)",
      artists: ["周杰伦"],
      album: "叶惠美",
      duration: 300,
    },
    {
      provider: "netease",
      providerTrackId: "888",
      title: "晴天",
      artists: ["RyaVocal"],
      duration: 269,
    },
  ];

  it("records the query, the candidates and the decision", () => {
    const lines: string[] = [];
    const original = console.debug;
    console.debug = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      rankCandidates(candidates, source, {
        provider: "netease",
        query: "晴天 周杰伦",
      });
    } finally {
      console.debug = original;
    }

    const text = lines.join("\n");
    // The query that was sent.
    expect(text).toContain('[match:netease] query="晴天 周杰伦"');
    // How many candidates came back.
    expect(text).toContain("candidates=3");
    // The component breakdown of the winner. The values are *tiers*,
    // not similarities: the title tier, the credit tier, the artist
    // agreement, the duration tier and the album tier.
    expect(text).toContain("t=4.00");
    expect(text).toContain("cr=3.00");
    expect(text).toContain("a=1.00");
    expect(text).toContain("d=5.00");
    expect(text).toContain("al=5.00");
    // The winner, and the margin over the runner-up.
    expect(text).toContain("PICK 186016");
    expect(text).toContain("margin=");
    // The rejected candidates are recorded too, with their reasons —
    // the live cut announces a version the source does not.
    expect(text).toContain("extra=live");
    expect(text).toContain("reason=");
  });

  it("records an empty result as its own outcome", () => {
    const lines: string[] = [];
    const original = console.debug;
    console.debug = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      rankCandidates([], source, { provider: "qq", query: "晴天 周杰伦" });
    } finally {
      console.debug = original;
    }

    const text = lines.join("\n");
    expect(text).toContain("candidates=0");
    expect(text).toContain("NO MATCH reason=no_candidates");
  });

  it("can be turned off", () => {
    const lines: string[] = [];
    const original = console.debug;
    console.debug = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    setMatchDebugEnabled(false);
    try {
      rankCandidates(candidates, source, {
        provider: "migu",
        query: "晴天 周杰伦",
      });
    } finally {
      console.debug = original;
      setMatchDebugEnabled(true);
    }
    expect(lines).toHaveLength(0);
  });
});
