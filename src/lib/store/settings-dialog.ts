import { create } from "zustand";

export type SettingsTab =
  | "general"
  | "playback"
  | "appearance"
  | "home"
  | "sources"
  | "storage"
  | "integrations";

/** The drill-in pages of the Integrations tab. */
export type IntegrationPage = "lastfm" | "discord" | "netease";

type State = {
  open: boolean;
  tab: SettingsTab;
  /** One-shot: the Integrations tab opens on this page (set by settings
   *  search so a result inside Last.fm / Discord lands on its page). */
  integrationPage: IntegrationPage | null;
  setOpen: (open: boolean) => void;
  setTab: (tab: SettingsTab) => void;
  setIntegrationPage: (page: IntegrationPage | null) => void;
};

/**
 * Ephemeral UI state for the settings popup (not persisted — the
 * dialog always opens on General). Lives in a store rather than local
 * state because unrelated corners of the app open it: the sidebar
 * footer, the title-bar menu, and the "Go to Settings" sign-in CTAs.
 */
export const useSettingsDialog = create<State>()((set) => ({
  open: false,
  tab: "general",
  integrationPage: null,
  setOpen: (open) => set({ open }),
  setTab: (tab) => set({ tab }),
  setIntegrationPage: (integrationPage) => set({ integrationPage }),
}));

/** Open the settings popup, optionally on a specific tab. */
export function openSettings(tab?: SettingsTab): void {
  useSettingsDialog.setState(tab ? { open: true, tab } : { open: true });
}

/**
 * Open the settings popup on a drill-in page of the Integrations tab.
 *
 * Used by the sign-in CTAs that live outside the settings window — the
 * NetEase shelf's prompt, for one — so the user lands on the exact row
 * they need rather than having to find it.
 */
export function openSettingsIntegration(page: IntegrationPage): void {
  useSettingsDialog.setState({
    open: true,
    tab: "integrations",
    integrationPage: page,
  });
}
