import { describe, expect, it } from "vitest";
import {
  getProviderOrder,
  setProviderOrder,
  subscribeProviderOrder,
} from "@/lib/providers/order";
import {
  PROVIDER_PRIORITY,
  type ProviderId,
} from "@/lib/providers/types";

/**
 * The provider priority order.
 *
 * The order decides which source serves a track when more than one of
 * them has it. It is what the settings list's up/down buttons change,
 * and the bug this covers was that the buttons moved an array the list
 * did not render — the order changed and the screen did not.
 */
describe("the provider priority order", () => {
  /** The order every test starts from. */
  const base = (): ProviderId[] => [...PROVIDER_PRIORITY];

  it("starts at the default order", () => {
    setProviderOrder(base());
    expect(getProviderOrder()).toEqual(PROVIDER_PRIORITY);
  });

  it("takes the order it is given", () => {
    const next: ProviderId[] = ["netease", "youtube", "migu", "kugou", "qq"];
    setProviderOrder(next);
    expect(getProviderOrder()).toEqual(next);
    setProviderOrder(base());
  });

  it("keeps the order when a provider is moved up", () => {
    // The exact move the up button performs.
    const before = base();
    const index = before.indexOf("netease");
    const next = before.slice();
    const [moved] = next.splice(index, 1);
    next.splice(index - 1, 0, moved);

    setProviderOrder(next);
    expect(getProviderOrder()).toEqual(next);
    expect(getProviderOrder()[index - 1]).toBe("netease");
    setProviderOrder(base());
  });

  it("keeps the order when a provider is moved down", () => {
    const before = base();
    const index = before.indexOf("youtube");
    const next = before.slice();
    const [moved] = next.splice(index, 1);
    next.splice(index + 1, 0, moved);

    setProviderOrder(next);
    expect(getProviderOrder()).toEqual(next);
    expect(getProviderOrder()[index + 1]).toBe("youtube");
    setProviderOrder(base());
  });

  it("tells its subscribers about the change", () => {
    // The list keeps a local mirror of the order so it re-renders;
    // without this notification the mirror would drift away from the
    // authoritative copy — which is how the buttons came to look
    // broken in the first place.
    let notified = 0;
    const unsubscribe = subscribeProviderOrder(() => {
      notified += 1;
    });

    const before = base();
    setProviderOrder([...before].reverse());
    unsubscribe();

    expect(notified).toBe(1);
    setProviderOrder(before);
  });

  it("drops a provider the app no longer has", () => {
    const before = base();
    setProviderOrder([...before, "spotify" as ProviderId]);
    // Spotify is metadata-only, so it is not in the playable order.
    expect(getProviderOrder()).not.toContain("spotify");
    setProviderOrder(before);
  });
});
