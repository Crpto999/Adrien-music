import { INTL_LOCALE, type Locale } from "@/lib/i18n/locales";
import { useLocaleStore } from "@/lib/store/locale";
import type { TranslateParams } from "@/lib/i18n/types";

/** The active locale, read imperatively (for non-React callers). */
function activeLocale(): Locale {
  return useLocaleStore.getState().locale;
}

/** "1.4 MB"-style human size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * "3h ago"-style relative time from unix seconds; dates past a week.
 *
 * The wording comes from the dictionary so it reads in the app's
 * language — "3 小时前" rather than "3h ago".
 */
export function formatRelative(unixSecs: number, t: TranslateFn): string {
  if (!unixSecs) return "";
  const diff = Math.max(0, Date.now() / 1000 - unixSecs);
  if (diff < 60) return t("time.justNow");
  if (diff < 3600) return t("time.minutesAgo", { count: Math.floor(diff / 60) });
  if (diff < 86400) return t("time.hoursAgo", { count: Math.floor(diff / 3600) });
  if (diff < 86400 * 7)
    return t("time.daysAgo", { count: Math.floor(diff / 86400) });
  const d = new Date(unixSecs * 1000);
  return d.toLocaleDateString(INTL_LOCALE[activeLocale()]);
}

/** "Jul 11, 2026, 3:42 PM"-style absolute date + time from unix ms,
 *  localized to the user's system settings and the app's language. */
export function formatDateTime(unixMs: number): string {
  return new Date(unixMs).toLocaleString(INTL_LOCALE[activeLocale()], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** The translator signature the format helpers take. */
export type TranslateFn = (
  key: string,
  params?: TranslateParams,
) => string;
