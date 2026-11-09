import { useApplyTheme } from "./use-apply-theme";

/**
 * Applies the selected theme to the document.
 *
 * Mounted once per window (the main window and the standalone floating
 * player each have their own React root), right at the top of the tree
 * so the theme is painted before anything else renders.
 *
 * The theme choice itself lives in `store.ts`; this component only
 * reflects it onto the DOM. It replaces the `next-themes` provider the
 * app used before, because the built-in one only knows about `light` and
 * `dark` — the theme registry here is open, so a user-defined theme can
 * be added without a new provider.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useApplyTheme();
  return <>{children}</>;
}
