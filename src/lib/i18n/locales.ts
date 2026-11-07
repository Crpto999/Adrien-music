/**
 * Locale definitions.
 *
 * A locale drives three independent things:
 *   1. the UI strings (this module's dictionaries),
 *   2. the InnerTube request's `hl` (response language),
 *   3. the InnerTube request's `gl` (content region).
 *
 * `gl` is deliberately NOT "CN" for zh-CN: InnerTube rejects `gl=CN`
 * (and `gl=MO`) with HTTP 400 "Request contains an invalid argument",
 * verified against the live API. `SG` is a Simplified-Chinese region that
 * the API accepts, so it stands in for CN.
 */
export const LOCALES = ["en", "zh-CN"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "zh-CN";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The locale shown in the settings picker, in its own language. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

/**
 * InnerTube `gl` (content region) per locale.
 *
 * Chosen from regions the API actually accepts — `CN` and `MO` are
 * rejected outright, so a user picking Simplified Chinese would get a
 * hard 400 on every request if we sent `CN`.
 */
export const LOCALE_REGIONS: Record<Locale, string> = {
  en: "US",
  "zh-CN": "SG",
};

/** BCP-47 tag for `Intl` / `toLocaleDateString`. */
export const INTL_LOCALE: Record<Locale, string> = {
  en: "en-US",
  "zh-CN": "zh-CN",
};
