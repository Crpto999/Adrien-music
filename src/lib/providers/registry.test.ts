import { describe, expect, it } from "vitest";
import { hasProvider } from "@/lib/providers/resolve";
import { PROVIDER_PRIORITY } from "@/lib/providers/types";

/**
 * The provider registry must never be empty.
 *
 * The registry is populated by a side-effect import. Nothing in the
 * app imports the adapter bundle *explicitly* — the resolver does it,
 * on the resolver's behalf, because the resolver is the module that
 * reads the registry. If that import is ever dropped or moved, the
 * registry goes empty and every cross-provider search silently returns
 * "no other source has this track" — with no error anywhere. This
 * test is the tripwire for that.
 */
describe("the provider registry", () => {
  it("has an adapter for every playable provider", () => {
    for (const provider of PROVIDER_PRIORITY) {
      expect(hasProvider(provider), `${provider} has no adapter`).toBe(true);
    }
  });

  it("has adapters for the Chinese platforms", () => {
    expect(hasProvider("migu")).toBe(true);
    expect(hasProvider("kugou")).toBe(true);
    expect(hasProvider("qq")).toBe(true);
  });
});
