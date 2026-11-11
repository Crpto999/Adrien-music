/**
 * The provider layer's public surface.
 *
 * Importing this module registers the built-in adapters, so any code
 * that reaches the resolver through here gets a working provider
 * registry without having to know which adapters exist.
 */

export * from "@/lib/providers/types";
export {
  scoreMatch,
  scoreCandidateDetailed,
  artistsAgree,
  scoreCandidate,
  decideConfidence,
  failureReason,
  isCoverFallback,
  passesGates,
  compareKeys,
  CASCADE,
  normalizeText,
  normalizeSong,
  splitFeat,
  versionTags,
  titleVariants,
  titleForms,
  stripAnnotation,
  decompose,
  isGenericArtist,
  searchTitle,
  matchCacheKey,
  readMatchCache,
  writeMatchCache,
  withMatchCache,
  clearMatchCache,
  MATCH_CACHE_TTL,
  jaroWinkler,
  titleAgreement,
  artistAgreement,
  creditAgreement,
  durationAgreement,
  albumAgreement,
  versionAgreement,
  rankScore,
  normalizeAliases,
  scriptOf,
} from "@/lib/providers/match";
export type {
  MatchCandidate,
  MatchComponents,
  MatchConfidence,
  MatchKey,
  MatchScore,
  MatchSource,
} from "@/lib/providers/match";
export * from "@/lib/providers/resolve";
export * from "@/lib/providers/playback";
export * from "@/lib/providers/queue";
export * from "@/lib/providers/unblock";
export * from "@/lib/providers/order";
export * from "@/lib/providers/availability";
export * from "@/lib/providers/probe";

import { registerBuiltinProviders } from "@/lib/providers/adapters";

registerBuiltinProviders();
