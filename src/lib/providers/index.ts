/**
 * The provider layer's public surface.
 *
 * Importing this module registers the built-in adapters, so any code
 * that reaches the resolver through here gets a working provider
 * registry without having to know which adapters exist.
 */

export * from "@/lib/providers/types";
export * from "@/lib/providers/match";
export * from "@/lib/providers/resolve";
export * from "@/lib/providers/playback";
export * from "@/lib/providers/queue";
export * from "@/lib/providers/unblock";

import { registerBuiltinProviders } from "@/lib/providers/adapters";

registerBuiltinProviders();
