/**
 * The third-party unblock pool's health, as the backend reports it.
 *
 * The pool is a set of public HTTP APIs that resolve a NetEase song id
 * to a playable URL for tracks the platform gates behind a membership
 * tier. They are volunteer-run, so each one is probed and the ones that
 * stop answering are dropped. This module is the frontend's view of
 * that pool — the settings tab renders it, and the backend owns it.
 */

export type UnblockHealth = "unknown" | "ok" | "degraded" | "down";

export type UnblockEndpointStatus = {
  id: string;
  label: string;
  /** 1 = SVIP, 2 = SVIP (unstable account), 3 = VIP, 4 = VIP (unstable). */
  tier: number;
  /** The user turned this endpoint off. */
  disabled: boolean;
  /** The endpoint was dropped from the pool after repeated failures. */
  removed: boolean;
  health: UnblockHealth;
  /** Round-trip time of the last probe, in milliseconds. */
  latencyMs: number | null;
  /** Unix seconds of the last probe. */
  lastChecked: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  /** Unix seconds of the removal. */
  removedAt: number | null;
};

export type UnblockPoolConfig = {
  probeIntervalMinutes: number;
  probeOnStartup: boolean;
  failureThreshold: number;
  /** The NetEase song id used to probe the endpoints. */
  probeSongId: string;
  /** Per-endpoint API key overrides. */
  keys: Record<string, string>;
};

/** What a tier means, for the settings UI. */
export const UNBLOCK_TIER_LABELS: Record<number, string> = {
  1: "SVIP",
  2: "SVIP (unstable)",
  3: "VIP",
  4: "VIP (unstable)",
};

/** A stable label for the health state, for the settings UI. */
export function unblockHealthTone(
  health: UnblockHealth,
): "ok" | "warn" | "bad" | "idle" {
  switch (health) {
    case "ok":
      return "ok";
    case "degraded":
      return "warn";
    case "down":
      return "bad";
    default:
      return "idle";
  }
}
