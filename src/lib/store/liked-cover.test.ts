import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = new Map<string, string>();
const storage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => saved.set(key, value),
  removeItem: (key: string) => saved.delete(key),
};
vi.stubGlobal("window", { localStorage: storage });

const { DEFAULT_LIKED_COVER_PRESET, useLikedCoverStore } =
  await import("./liked-cover");

beforeEach(() => {
  saved.clear();
  useLikedCoverStore.setState({
    preset: DEFAULT_LIKED_COVER_PRESET,
    custom: null,
  });
});

describe("Liked songs cover preferences", () => {
  it("defaults to the theme-aware preset", () => {
    expect(useLikedCoverStore.getInitialState().preset).toBe("theme");
  });

  it("restores the selected preset after removing an uploaded image", () => {
    const store = useLikedCoverStore.getState();
    store.setCustom("data:image/jpeg;base64,test");
    expect(useLikedCoverStore.getState().custom).not.toBeNull();
    store.clearCustom();
    expect(useLikedCoverStore.getState()).toMatchObject({
      preset: "theme",
      custom: null,
    });
  });

  it("clears an uploaded image when choosing a preset", () => {
    const store = useLikedCoverStore.getState();
    store.setCustom("data:image/jpeg;base64,test");
    store.setPreset("glow");
    expect(useLikedCoverStore.getState()).toMatchObject({
      preset: "glow",
      custom: null,
    });
  });

  it.each(["adrify", "default", "clear", "glow"] as const)(
    "preserves a previously saved %s preset",
    async (preset) => {
      saved.set(
        "ytm-liked-cover",
        JSON.stringify({ state: { preset, custom: null }, version: 0 }),
      );
      await useLikedCoverStore.persist.rehydrate();
      expect(useLikedCoverStore.getState().preset).toBe(preset);
    },
  );

  it("preserves uploaded artwork across hydration", async () => {
    const custom = "data:image/jpeg;base64,saved";
    saved.set(
      "ytm-liked-cover",
      JSON.stringify({ state: { preset: "adrify", custom }, version: 0 }),
    );
    await useLikedCoverStore.persist.rehydrate();
    expect(useLikedCoverStore.getState()).toMatchObject({
      preset: "adrify",
      custom,
    });
  });
});
