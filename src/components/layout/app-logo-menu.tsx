import { type ReactNode, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import {
  IconBugFilled,
  IconExternalLink,
  IconInfoCircleFilled,
  IconLayoutBottombarFilled,
  IconLayoutFilled,
  IconLayoutSidebarRightFilled,
  IconPaletteFilled,
  IconSettingsFilled,
} from "@tabler/icons-react";

import { IconPowerFilled } from "@/components/shared/filled-icons";
import { ThemeGlyph, useThemeChoices } from "@/components/shared/theme-choices";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { AboutDialog } from "@/components/layout/about-dialog";
import { ReportIssueDialog } from "@/components/layout/report-issue-dialog";
import { useLayoutStore, type LayoutMode } from "@/lib/store/layout";
import { openSettings } from "@/lib/store/settings-dialog";
import { SYSTEM_THEME_ID, useThemeStore } from "@/lib/theme";
import { useT } from "@/lib/i18n";

/**
 * The app menu, attached to the sidebar's logo.
 *
 * It used to live behind the "more" (⋯) button in the title bar, but a
 * menu that owns settings, layout, theme, feedback, about and quitting
 * is the app's own menu — it belongs with the mark that names the app.
 * The title bar keeps only the chrome it is actually for: the sidebar
 * toggle and the history buttons.
 *
 * Right-clicking the logo opens the menu; a plain click is a normal
 * navigation home.
 */
export function AppLogoMenu({ children }: { children: ReactNode }) {
  const t = useT();
  const navigate = useNavigate();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={t("app.name")}
          onClick={() => void navigate({ to: "/" })}
          className="w-full cursor-pointer rounded-md outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {children}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={() => openSettings()}>
          <IconSettingsFilled />
          {t("menu.settings")}
        </ContextMenuItem>
        <LayoutSubMenu />
        <ThemeSubMenu />

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={() => setReportOpen(true)}>
          <IconBugFilled />
          {t("menu.reportIssue")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => setAboutOpen(true)}>
          <IconInfoCircleFilled />
          {t("menu.about")}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          variant="destructive"
          onSelect={() => {
            void invoke("quit_app");
          }}
        >
          <IconPowerFilled />
          {t("menu.quit")}
        </ContextMenuItem>
      </ContextMenuContent>

      <ReportIssueDialog open={reportOpen} onOpenChange={setReportOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </ContextMenu>
  );
}

/**
 * Where the player card lives: docked to the side, docked to the
 * bottom, or floating in its own window.
 */
function LayoutSubMenu() {
  const t = useT();
  const mode = useLayoutStore((s) => s.mode);
  const setMode = useLayoutStore((s) => s.setMode);
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <IconLayoutFilled />
        {t("menu.layout")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuRadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as LayoutMode)}
        >
          <ContextMenuRadioItem value="right">
            <IconLayoutSidebarRightFilled className="size-4" />
            {t("player.sideCard")}
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="bottom">
            <IconLayoutBottombarFilled className="size-4" />
            {t("player.bottomBar")}
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="floating">
            <IconExternalLink className="size-4" />
            {t("player.floatingWindow")}
          </ContextMenuRadioItem>
        </ContextMenuRadioGroup>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/**
 * The theme picker. The list comes from the theme registry, so a theme
 * added there shows up here without another edit.
 */
function ThemeSubMenu() {
  const t = useT();
  const { options, labelFor } = useThemeChoices();
  const themeId = useThemeStore((s) => s.themeId);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <IconPaletteFilled />
        {t("menu.theme")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuRadioGroup
          value={themeId}
          onValueChange={(v) => setThemeId(v)}
        >
          {options.map((opt) => (
            <ContextMenuRadioItem key={opt.id} value={opt.id}>
              <ThemeGlyph id={opt.id} />
              {labelFor(opt)}
            </ContextMenuRadioItem>
          ))}
          <ContextMenuRadioItem value={SYSTEM_THEME_ID}>
            <ThemeGlyph id={SYSTEM_THEME_ID} />
            {t("theme.system")}
          </ContextMenuRadioItem>
        </ContextMenuRadioGroup>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
