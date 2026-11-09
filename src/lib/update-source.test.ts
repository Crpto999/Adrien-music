import { describe, expect, it } from "vitest";
import {
  aurUpdateCmd,
  fetchUpdateSource,
  normalizeManager,
  systemUpdateGuidance,
} from "@/lib/update-source";

describe("normalizeManager", () => {
  it("passes known managers through", () => {
    expect(normalizeManager("aur")).toBe("aur");
    expect(normalizeManager("apt")).toBe("apt");
    expect(normalizeManager("dnf")).toBe("dnf");
    expect(normalizeManager("unknown")).toBe("unknown");
  });

  it("falls back to unknown for garbage", () => {
    expect(normalizeManager("pacman")).toBe("unknown");
    expect(normalizeManager(undefined)).toBe("unknown");
    expect(normalizeManager(null)).toBe("unknown");
    expect(normalizeManager(42)).toBe("unknown");
  });
});

describe("aurUpdateCmd", () => {
  it("uses the detected helper", () => {
    expect(aurUpdateCmd("paru")).toBe("paru -Syu adrify");
    expect(aurUpdateCmd("yay")).toBe("yay -Syu adrify");
    expect(aurUpdateCmd("pikaur")).toBe("pikaur -Syu adrify");
  });

  it("falls back to yay for missing/garbage helpers", () => {
    expect(aurUpdateCmd("")).toBe("yay -Syu adrify");
    expect(aurUpdateCmd("pacman")).toBe("yay -Syu adrify");
  });
});

describe("systemUpdateGuidance", () => {
  it("gives AUR users a copyable refresh command for their helper", () => {
    const g = systemUpdateGuidance("aur", "paru");
    expect(g.channel).toBe("AUR");
    expect(g.actionLabel).toBe("Copy command");
    expect(g.command).toBe("paru -Syu adrify");
    expect(g.blurb).toContain("paru -Syu adrify");
  });

  it("defaults to yay when no helper was detected", () => {
    const g = systemUpdateGuidance("aur", "");
    expect(g.command).toBe("yay -Syu adrify");
  });

  it("points deb/rpm/unknown installs at the Releases page", () => {
    for (const m of ["apt", "dnf", "unknown"] as const) {
      const g = systemUpdateGuidance(m);
      expect(g.command).toBeUndefined();
      expect(g.actionLabel).toBe("Releases");
      expect(g.blurb).toContain("system package");
    }
  });
});

describe("fetchUpdateSource", () => {
  it("resolves inApp without IPC outside Linux (node has no navigator)", () => {
    // Vitest runs in node: IS_LINUX is false, so no invoke happens and
    // this also proves the browser-preview fallback path.
    return expect(fetchUpdateSource()).resolves.toEqual({
      kind: "inApp",
      manager: "unknown",
      helper: "",
    });
  });
});
