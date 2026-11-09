import type { ProviderCandidate, ProviderId } from "@/lib/providers/types";

/**
 * The provider adapter registry.
 *
 * This module exists apart from `resolve.ts` for one reason: the
 * registry must be writable from the adapter modules, and the resolver
 * must *read* it — and if the resolver also owned the registration
 * function, the two would import each other in a cycle. Keeping the
 * map here breaks that: the adapters write to it, the resolver reads
 * from it, and neither knows about the other.
 *
 * The type import is erased at build time, so this module has no
 * runtime dependency of its own.
 */

/**
 * A provider's search implementation.
 *
 * Each provider adapter supplies this and nothing else; the ranking
 * and the priority logic live in the resolver so every provider is
 * judged by the same rules.
 */
export type ProviderSearch = (
  query: string,
  signal?: AbortSignal,
) => Promise<ProviderCandidate[]>;

/** The registered provider adapters. */
const adapters = new Map<ProviderId, ProviderSearch>();

/** Register a provider's search implementation. */
export function registerProvider(
  provider: ProviderId,
  search: ProviderSearch,
): void {
  adapters.set(provider, search);
}

/** Whether a provider has an adapter registered. */
export function hasProvider(provider: ProviderId): boolean {
  return adapters.has(provider);
}

/** The registered adapter for a provider, if there is one. */
export function getProviderAdapter(
  provider: ProviderId,
): ProviderSearch | undefined {
  return adapters.get(provider);
}
