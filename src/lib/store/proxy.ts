import { create } from "zustand";
import { persist } from "zustand/middleware";

type State = {
  /**
   * The proxy URL as the user typed it.
   *
   * Empty means "no proxy" — every network path then connects
   * directly. The raw value (not the normalized one) is stored so the
   * settings field shows exactly what the user typed.
   */
  url: string;
  setUrl: (url: string) => void;
};

/**
 * The user's proxy setting.
 *
 * Kept in its own store (rather than folded into `settings.ts`) because
 * the InnerTube layer, the lyrics providers and the Last.fm client all
 * read it at request time, outside React.
 *
 * The main and floating-player windows are separate JS contexts sharing
 * localStorage, so the `storage` listener below re-hydrates on a change
 * made in the other window — same pattern as `store/settings.ts`.
 */
export const useProxyStore = create<State>()(
  persist(
    (set) => ({
      url: "",
      setUrl: (url) => set({ url }),
    }),
    { name: "ytm-proxy" },
  ),
);

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "ytm-proxy") {
      void useProxyStore.persist.rehydrate();
    }
  });
}
