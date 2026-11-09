import { registerProvider } from "@/lib/providers/registry";
import { searchNetEase } from "@/lib/providers/adapters/netease";
import { searchYouTube } from "@/lib/providers/adapters/youtube";
import {
  searchKugou,
  searchMigu,
  searchQQ,
} from "@/lib/providers/adapters/cn";

/**
 * Register the built-in provider adapters.
 *
 * Registration is idempotent and happens at module load, so importing
 * this file once is enough to make the whole app provider-aware.
 */

let registered = false;

/** Register every built-in adapter. Safe to call more than once. */
export function registerBuiltinProviders(): void {
  if (registered) return;
  registered = true;
  registerProvider("youtube", searchYouTube);
  registerProvider("netease", searchNetEase);
  registerProvider("migu", searchMigu);
  registerProvider("kugou", searchKugou);
  registerProvider("qq", searchQQ);
}

// Register on import. The resolver is imported by the playback engine
// and by the source-switch UI, and neither of them knows that adapter
// modules exist — so the registration has to happen as a side effect
// of the module graph rather than as something a caller remembers to
// do.
registerBuiltinProviders();
