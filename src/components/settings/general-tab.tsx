import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// Filled Tabler glyphs: the settings rows read as solid marks on their
// tinted tiles, not as line art.
import {
  IconBellFilled,
  IconBoltFilled,
  IconBug,
  IconCheck,
  IconChevronDown,
  IconCircleArrowDownFilled,
  IconFileText,
  IconLanguageKatakana,
  IconLoader2,
  IconLogin,
  IconSquareXFilled,
  IconUserFilled,
  IconWorldFilled,
} from "@tabler/icons-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { Input } from "@/components/ui/input";
import { IS_MAC } from "@/lib/platform";
import { authLoggedInQuery } from "@/lib/store/auth-queries";
import { useSettingsStore } from "@/lib/store/settings";
import { useLocaleStore } from "@/lib/store/locale";
import { useProxyStore } from "@/lib/store/proxy";
import { normalizeProxyUrl } from "@/lib/proxy";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n/locales";
import { useT } from "@/lib/i18n";
import { copyToClipboard } from "@/lib/clipboard";
import { checkForUpdates } from "@/lib/updater";
import {
  aurUpdateCmd,
  systemUpdateGuidance,
  useUpdateSource,
} from "@/lib/update-source";

export function GeneralTab() {
  return (
    <TabPane>
      <AccountGroup />
      <BehaviorGroup />
      <ProxyRow />
      <DiagnosticsRow />
    </TabPane>
  );
}

/* ------------------------------------------------------------------ */
/* Language                                                            */
/* ------------------------------------------------------------------ */

/**
 * The language picker.
 *
 * The locale drives three things at once: the UI strings, the `hl` sent
 * with every InnerTube request (so YTM's own labels — "歌曲", "专辑" —
 * come back in the chosen language) and the `gl` region. `LOCALE_LABELS`
 * names each language in that language itself, which is the convention
 * every OS language list follows.
 */
function LanguageRow() {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);

  return (
    <SettingRow
      icon={IconLanguageKatakana}
      settingId="language"
      title={t("settings.language.title")}
      description={t("settings.language.description")}
      control={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 w-[196px] cursor-pointer items-center gap-2 rounded-[10px] border border-w090 bg-w040 px-3 text-[13px] text-t2 transition-colors duration-[140ms] hover:bg-w070 data-[state=open]:border-w200"
            >
              <span className="min-w-0 flex-1 truncate text-left">
                {LOCALE_LABELS[locale]}
              </span>
              <IconChevronDown className="size-3 shrink-0 text-t6" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[232px]">
            {LOCALES.map((id: Locale) => (
              <DropdownMenuItem key={id} onSelect={() => setLocale(id)}>
                <span className="flex-1 truncate">{LOCALE_LABELS[id]}</span>
                {locale === id ? (
                  <IconCheck className="size-4 text-active!" stroke={2.4} />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}

/* ------------------------------------------------------------------ */
/* Network                                                            */
/* ------------------------------------------------------------------ */

/**
 * The proxy setting, at the very bottom of the General tab.
 *
 * One URL covers every outbound path: HTTP/HTTPS proxies and SOCKS
 * (socks4 / socks4a / socks5 / socks5h) are both accepted. Leaving it
 * empty disables the proxy entirely — nothing is routed through a
 * proxy in that case.
 *
 * The value is validated on blur rather than on every keystroke: a
 * half-typed `socks5://…` is invalid in the middle of typing, and
 * shouting at the user mid-word is noise. The stored value is the raw
 * text; the normalization happens per request.
 */
function ProxyRow() {
  const t = useT();
  const url = useProxyStore((s) => s.url);
  const setUrl = useProxyStore((s) => s.setUrl);
  const [draft, setDraft] = useState(url);
  const [error, setError] = useState<string | null>(null);

  // Adopt a value that changed elsewhere (the floating player window,
  // or a reset) without clobbering what the user is typing.
  useEffect(() => {
    setDraft(url);
    setError(null);
  }, [url]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError(null);
      setUrl("");
      return;
    }
    try {
      normalizeProxyUrl(trimmed);
      setError(null);
      setUrl(trimmed);
    } catch (e) {
      setError(
        (e as Error).message === "scheme"
          ? t("settings.general.proxyUnsupportedScheme")
          : t("settings.general.proxyInvalid"),
      );
    }
  };

  return (
    <Group>
      <SettingRow
        icon={IconWorldFilled}
        settingId="proxy"
        title={t("settings.general.proxy")}
        description={t("settings.general.proxyDesc")}
        control={
          <div className="flex w-[280px] flex-col items-end gap-1">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                }
              }}
              placeholder={t("settings.general.proxyPlaceholder")}
              aria-label={t("settings.general.proxy")}
              aria-invalid={!!error}
              spellCheck={false}
              autoComplete="off"
              className="h-8 w-full text-[13px]"
            />
            {error ? (
              <span className="text-[11.5px] leading-none text-destructive">
                {error}
              </span>
            ) : null}
          </div>
        }
      />
    </Group>
  );
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

/**
 * Where the log file is.
 *
 * A packaged build is launched detached from a console, so the
 * backend's diagnostics — session renewals, cookie-jar decrypt
 * failures, yt-dlp spawn errors — have nowhere to go except this
 * file. Showing its path here is what makes a bug report actionable:
 * without it the user has nothing to attach.
 */
function DiagnosticsRow() {
  const t = useT();
  const matchDebugLog = useSettingsStore((s) => s.matchDebugLog);
  const setMatchDebugLog = useSettingsStore((s) => s.setMatchDebugLog);
  const { data: logPath } = useQuery({
    queryKey: ["log-path"],
    queryFn: () => invoke<string | null>("get_log_path"),
    staleTime: Infinity,
    retry: false,
  });

  return (
    <Group>
      <SettingRow
        icon={IconBug}
        settingId="matchDebugLog"
        title={t("settings.general.matchDebugLog")}
        description={t("settings.general.matchDebugLogDesc")}
        control={
          <Switch
            checked={matchDebugLog}
            onCheckedChange={setMatchDebugLog}
          />
        }
      />
      {logPath ? (
        <SettingRow
          icon={IconFileText}
          settingId="diagnostics"
          title={t("settings.general.logPath")}
          description={t("settings.general.logPathDesc")}
          control={
            <button
              type="button"
              title={logPath}
              onClick={() => {
                void copyToClipboard(logPath).then((ok) => {
                  if (ok) toast.success(t("toast.logPathCopied"));
                  else toast.error(t("toast.couldNotCopyLink"));
                });
              }}
              className="w-[280px] cursor-pointer truncate rounded-[10px] border border-w090 bg-w040 px-3 py-1.5 text-start text-[12px] text-t4 transition-colors duration-[140ms] hover:bg-w070"
            >
              {logPath}
            </button>
          }
        />
      ) : null}
    </Group>
  );
}

/* ------------------------------------------------------------------ */
/* Account                                                             */
/* ------------------------------------------------------------------ */

function AccountGroup() {
  const t = useT();
  const [signingIn, setSigningIn] = useState(false);
  const loggedIn = useQuery(authLoggedInQuery);

  useEffect(() => {
    // This tab owns the in-flight spinner + the toast feedback for a
    // sign-in started from the button below. Query invalidation +
    // InnerTube client reset live in the global
    // `useLoginSuccessListener` so they fire regardless of where the
    // sign-in was initiated (here or from a library/search empty
    // state).
    const unlistenSuccess = listen("login-success", () => {
      setSigningIn(false);
      toast.success(t("toast.signedIn"));
    });
    const unlistenCancel = listen("login-cancelled", () => {
      setSigningIn(false);
    });
    return () => {
      unlistenSuccess.then((fn) => fn());
      unlistenCancel.then((fn) => fn());
    };
  }, [t]);

  const signIn = async () => {
    setSigningIn(true);
    try {
      await invoke("start_login");
    } catch (e) {
      setSigningIn(false);
      // The error goes in the DESCRIPTION: the toast's title is
      // truncated to a single line, which is what used to hide the
      // informative half of the message.
      toast.error(t("action.signIn"), { description: String(e) });
    }
  };

  // Once signed in, identity, channel switching, and sign-out all live
  // in the sidebar account menu, so this tab shows nothing for the
  // account. The signed-out sign-in prompt stays because the sidebar
  // renders nothing when logged out and the library/search empty
  // states send the user here to sign in. `!== false` keeps the prompt
  // hidden while the auth check is still loading so a signed-in user
  // never sees a flash of "Not signed in".
  if (loggedIn.data !== false) return null;

  return (
    <Group>
      {/* Hand-rolled rather than a SettingRow: the avatar replaces the
          icon tile, but the geometry has to match its siblings exactly. */}
      <div className="flex items-center gap-3.5 py-4">
        <Avatar className="size-8 rounded-[9px] border border-w070 bg-w050">
          <AvatarFallback className="rounded-[9px] bg-transparent text-t5">
            <IconUserFilled className="size-4" />
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="text-sm font-semibold leading-none text-t2">
            {t("auth.notSignedIn")}
          </span>
          <span className="text-[12.5px] leading-snug text-t7">
            {t("auth.notSignedInHint")}
          </span>
        </div>
        <Button size="sm" onClick={signIn} disabled={signingIn}>
          {signingIn ? (
            <IconLoader2 className="animate-spin" />
          ) : (
            <IconLogin stroke={2.3} />
          )}
          {t("auth.signInWithGoogle")}
        </Button>
      </div>
    </Group>
  );
}

/* ------------------------------------------------------------------ */
/* Behavior                                                            */
/* ------------------------------------------------------------------ */

function BehaviorGroup() {
  const t = useT();
  const closeAction = useSettingsStore((s) => s.closeAction);
  const setCloseAction = useSettingsStore((s) => s.setCloseAction);
  const playbackNotifications = useSettingsStore(
    (s) => s.playbackNotifications,
  );
  const setPlaybackNotifications = useSettingsStore(
    (s) => s.setPlaybackNotifications,
  );
  const autoUpdate = useSettingsStore((s) => s.autoUpdate);
  const setAutoUpdate = useSettingsStore((s) => s.setAutoUpdate);
  // System installs (AUR, .deb/.rpm) are updated by the package manager:
  // the toggle would promise downloads the app must never perform.
  const { data: updateSource } = useUpdateSource();
  const systemManaged = updateSource?.kind === "system";
  const managedNote = systemManaged
    ? systemUpdateGuidance(updateSource.manager, updateSource.helper)
        .channel === "AUR"
      ? t("settings.general.pacmanManaged", {
          command: aurUpdateCmd(updateSource.helper),
        })
      : t("settings.general.packageManaged")
    : null;

  const toggleAutoUpdate = (enabled: boolean) => {
    setAutoUpdate(enabled);
    // Switching it on runs the check the launch skipped, so a version
    // found while it was off (or never looked for) starts downloading
    // now rather than after the next restart.
    if (enabled) void checkForUpdates({ silent: true });
  };

  const qc = useQueryClient();
  const autostart = useQuery({
    queryKey: ["autostart"],
    queryFn: () => invoke<boolean>("autostart_is_enabled"),
    staleTime: 60_000,
    retry: false,
  });

  const toggleAutostart = async (enabled: boolean) => {
    try {
      await invoke("autostart_set", { enabled });
    } catch (e) {
      toast.error(String(e));
    }
    // Re-read the OS registration either way — it's the source of
    // truth, and the failed path needs the switch snapped back.
    await qc.invalidateQueries({ queryKey: ["autostart"] });
  };

  const closeTitle = IS_MAC
    ? t("settings.general.closeToMenuBar")
    : t("settings.general.closeToTray");
  const closeDescription = IS_MAC
    ? t("settings.general.closeToMenuBarDesc")
    : t("settings.general.closeToTrayDesc");

  return (
    <Group>
      <LanguageRow />
      <SettingRow
        icon={IconBoltFilled}
        settingId="launch-at-startup"
        title={t("settings.general.launchAtStartup")}
        description={t("settings.general.launchAtStartupDesc")}
        control={
          <Switch
            checked={!!autostart.data}
            onCheckedChange={(v) => void toggleAutostart(v)}
            disabled={autostart.isLoading}
            aria-label={t("settings.general.launchAtStartup")}
          />
        }
      />
      <SettingRow
        icon={IconBellFilled}
        settingId="playback-notifications"
        title={t("settings.general.playbackNotifications")}
        description={t("settings.general.playbackNotificationsDesc")}
        control={
          <Switch
            checked={playbackNotifications}
            onCheckedChange={setPlaybackNotifications}
            aria-label={t("settings.general.playbackNotifications")}
          />
        }
      />
      <SettingRow
        icon={IconSquareXFilled}
        title={closeTitle}
        settingId="close-to-tray"
        description={closeDescription}
        control={
          <Switch
            checked={closeAction === "tray"}
            onCheckedChange={(v) => setCloseAction(v ? "tray" : "quit")}
            aria-label={closeTitle}
          />
        }
      />
      <SettingRow
        icon={IconCircleArrowDownFilled}
        settingId="automatic-updates"
        title={t("settings.general.automaticUpdates")}
        description={managedNote ?? t("settings.general.automaticUpdatesDesc")}
        control={
          <Switch
            checked={autoUpdate}
            onCheckedChange={toggleAutoUpdate}
            disabled={systemManaged}
            aria-label={t("settings.general.automaticUpdates")}
          />
        }
      />
    </Group>
  );
}
