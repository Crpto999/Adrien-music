import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentType,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  IconActivity,
  IconArrowLeft,
  IconChevronRight,
  IconClickFilled,
  IconClockFilled,
  IconDiscFilled,
  IconExternalLink,
  IconFilterFilled,
  IconHeartFilled,
  IconLoader2,
  IconLogin,
  IconLogout,
  IconMessageCircleFilled,
  IconMicrophoneFilled,
  IconPhotoFilled,
  IconTypography,
} from "@tabler/icons-react";
import {
  IconEyeOffFilled,
  IconMusicFilled,
  IconRadioFilled,
} from "@/components/shared/filled-icons";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { useSettingsDialog } from "@/lib/store/settings-dialog";
import { useLastfmStore, isLastfmLinked } from "@/lib/store/lastfm";
import {
  authorizeUrl,
  getSession,
  getToken,
  getUserInfo,
} from "@/lib/lastfm/api";
import { useDiscordStore, isDiscordConfigured } from "@/lib/store/discord";
import { useT } from "@/lib/i18n";

type IntegrationId = "lastfm" | "discord";

/**
 * List → detail navigation: the tab opens on a flat list of available
 * integrations (name + live status), and picking one drills into its
 * own submenu with a back row. Keeps each integration's settings from
 * cluttering a single long scroll as more integrations are added.
 */
export function IntegrationsTab() {
  const t = useT();
  // Settings search can ask for a drill-in page; consume the request once.
  const requested = useSettingsDialog((s) => s.integrationPage);
  const [active, setActive] = useState<IntegrationId | null>(requested);
  useEffect(() => {
    if (requested) useSettingsDialog.getState().setIntegrationPage(null);
  }, [requested]);

  if (active === "lastfm") {
    return (
      <TabPane>
        <BackRow label={t("settings.integrations.lastfm")} onBack={() => setActive(null)} />
        <LastfmGroup />
      </TabPane>
    );
  }
  if (active === "discord") {
    return (
      <TabPane>
        <BackRow
          label={t("settings.integrations.discord")}
          onBack={() => setActive(null)}
        />
        <DiscordGroup />
      </TabPane>
    );
  }

  return (
    <TabPane>
      <IntegrationListRow
        icon={IconMusicFilled}
        settingId="lastfm"
        title={t("settings.integrations.lastfm")}
        status={<LastfmStatusBadge />}
        onClick={() => setActive("lastfm")}
      />
      <IntegrationListRow
        icon={IconMessageCircleFilled}
        settingId="discord"
        title={t("settings.integrations.discord")}
        status={<DiscordStatusBadge />}
        onClick={() => setActive("discord")}
      />
    </TabPane>
  );
}

/** Back-navigation row atop a drilled-in integration's settings. Mirrors
 *  the SettingRow row-height/padding language so the submenu reads as a
 *  continuation of the same flat list, not a different surface. */
function BackRow({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-2 py-4 text-sm font-medium text-muted-foreground hover:text-foreground"
    >
      <IconArrowLeft className="size-4" />
      {label}
    </button>
  );
}

/** Clickable summary row for the integrations list — same visual shape
 *  as SettingRow (icon tile + title) with a status control and chevron
 *  standing in for SettingRow's `control` slot. */
function IntegrationListRow({
  icon: Icon,
  title,
  status,
  onClick,
  settingId,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  status: ReactNode;
  onClick: () => void;
  settingId: string;
}) {
  return (
    <button type="button" onClick={onClick} className="text-left">
      <SettingRow
        icon={Icon}
        title={title}
        settingId={settingId}
        control={
          <div className="flex shrink-0 items-center gap-2">
            {status}
            <IconChevronRight className="size-4 text-muted-foreground" />
          </div>
        }
      />
    </button>
  );
}

function LastfmStatusBadge() {
  const t = useT();
  const { apiKey, apiSecret, sessionKey, username, avatarUrl } =
    useLastfmStore();
  const linked = isLastfmLinked({ apiKey, apiSecret, sessionKey });
  return linked ? (
    <div className="flex items-center gap-1.5">
      {avatarUrl ? (
        <Avatar size="sm">
          <AvatarImage src={avatarUrl} alt="" />
          <AvatarFallback>{username?.[0]?.toUpperCase()}</AvatarFallback>
        </Avatar>
      ) : null}
      <Badge
        variant="secondary"
        className="bg-rose-500/15 text-rose-600 dark:text-rose-400"
      >
        {username ? `@${username}` : t("settings.integrations.connected")}
      </Badge>
    </div>
  ) : (
    <Badge variant="outline">{t("settings.integrations.notConnected")}</Badge>
  );
}

function DiscordStatusBadge() {
  const t = useT();
  const { enabled, applicationId } = useDiscordStore();
  const configured = isDiscordConfigured({ enabled, applicationId });
  return (
    <Badge
      variant={enabled ? "secondary" : "outline"}
      className={
        enabled && configured
          ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
          : undefined
      }
    >
      {!enabled
        ? t("settings.integrations.disabled")
        : configured
          ? t("settings.integrations.enabled")
          : t("settings.integrations.needsClientId")}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* Last.fm                                                             */
/* ------------------------------------------------------------------ */

const LASTFM_API_ACCOUNT_URL = "https://www.last.fm/api/account/create";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function LastfmGroup() {
  const t = useT();
  const {
    apiKey,
    apiSecret,
    sessionKey,
    username,
    avatarUrl,
    scrobblingEnabled,
    loveSyncEnabled,
    setCredentials,
    setSession,
    setAvatarUrl,
    setScrobblingEnabled,
    setLoveSyncEnabled,
    disconnect,
  } = useLastfmStore();
  const linked = isLastfmLinked({ apiKey, apiSecret, sessionKey });

  const [keyInput, setKeyInput] = useState(apiKey);
  const [secretInput, setSecretInput] = useState(apiSecret);
  const [connecting, setConnecting] = useState(false);
  // Lets the user abort the browser-authorization polling loop.
  const cancelledRef = useRef(false);

  // Best-effort avatar fetch: on connect, and lazily for an already-linked
  // account that doesn't have one cached yet (e.g. it linked before this
  // feature existed). Purely cosmetic — failures are silent.
  useEffect(() => {
    if (!linked || !username || avatarUrl) return;
    void getUserInfo({ apiKey, apiSecret }, username)
      .then((info) => setAvatarUrl(info.avatarUrl))
      .catch(() => {});
  }, [linked, username, avatarUrl, apiKey, apiSecret, setAvatarUrl]);

  const connect = async () => {
    const key = keyInput.trim();
    const secret = secretInput.trim();
    if (!key || !secret) {
      toast.error(t("toast.lastfmMissingCredentials"));
      return;
    }
    setCredentials(key, secret);
    const creds = { apiKey: key, apiSecret: secret };
    setConnecting(true);
    cancelledRef.current = false;
    try {
      const token = await getToken(creds);
      await openUrl(authorizeUrl(key, token));
      toast.info(t("toast.lastfmAuthorized"));
      // Poll for the authorized session. Last.fm returns error 14 ("token
      // not authorized") until the user grants access, and 15 once the
      // token expires (~1 hour, but we give up long before that).
      const startedAt = Date.now();
      while (!cancelledRef.current && Date.now() - startedAt < 150_000) {
        await sleep(3000);
        if (cancelledRef.current) break;
        try {
          const session = await getSession(creds, token);
          setSession(session.key, session.name);
          toast.success(
            t("settings.integrations.connectedAs", { name: session.name }),
          );
          return;
        } catch (e) {
          const code = (e as { code?: number }).code;
          if (code === 14) continue; // not authorized yet — keep waiting
          throw e; // any other error (expired token, network) is terminal
        }
      }
      if (!cancelledRef.current) {
        toast.error(t("toast.lastfmTimeout"));
      }
    } catch (e) {
      toast.error(
        t("settings.integrations.lastfmError", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setConnecting(false);
    }
  };

  const cancel = () => {
    cancelledRef.current = true;
    setConnecting(false);
  };

  const unlink = () => {
    disconnect();
    toast.success(t("toast.lastfmDisconnected"));
  };

  return (
    <Group>
      <SettingRow
        icon={IconMusicFilled}
        settingId="lastfm"
        title={t("settings.integrations.lastfm")}
        description={t("settings.integrations.lastfmDesc")}
        control={
          linked ? (
            <div className="flex shrink-0 items-center gap-2">
              {avatarUrl ? (
                <Avatar size="sm">
                  <AvatarImage src={avatarUrl} alt="" />
                  <AvatarFallback>
                    {username?.[0]?.toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ) : null}
              <Badge
                variant="secondary"
                className="bg-rose-500/15 text-rose-600 dark:text-rose-400"
              >
                {username ? `@${username}` : t("settings.integrations.connected")}
              </Badge>
              <Button variant="outline" size="sm" onClick={unlink}>
                <IconLogout stroke={2.3} />
                {t("settings.integrations.disconnect")}
              </Button>
            </div>
          ) : (
            <Badge variant="outline">
              {t("settings.integrations.notConnected")}
            </Badge>
          )
        }
      />
      {linked ? (
        <>
          <SettingRow
            icon={IconRadioFilled}
            settingId="scrobble-tracks"
            title={t("settings.integrations.scrobbleTracks")}
            description={t("settings.integrations.scrobbleTracksDesc")}
            control={
              <Switch
                checked={scrobblingEnabled}
                onCheckedChange={setScrobblingEnabled}
                aria-label={t("settings.integrations.enableScrobbling")}
              />
            }
          />
          <SettingRow
            icon={IconHeartFilled}
            settingId="love-liked-tracks"
            title={t("settings.integrations.loveLikedTracks")}
            description={t("settings.integrations.loveLikedTracksDesc")}
            control={
              <Switch
                checked={loveSyncEnabled}
                onCheckedChange={setLoveSyncEnabled}
                aria-label={t("settings.integrations.syncLovedTracks")}
              />
            }
          />
        </>
      ) : (
        <div className="flex flex-col gap-3 py-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="lastfm-key" className="text-sm font-medium">
              {t("settings.integrations.apiKey")}
            </label>
            <Input
              id="lastfm-key"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={t("settings.integrations.apiKey")}
              disabled={connecting}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="lastfm-secret" className="text-sm font-medium">
              {t("settings.integrations.apiSecret")}
            </label>
            <Input
              id="lastfm-secret"
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder={t("settings.integrations.apiSecret")}
              disabled={connecting}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            type="button"
            onClick={() => openUrl(LASTFM_API_ACCOUNT_URL)}
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("settings.integrations.createLastfmAccount")}
            <IconExternalLink className="size-3" />
          </button>
          <div className="flex items-center gap-2">
            <Button onClick={connect} disabled={connecting}>
              {connecting ? (
                <IconLoader2 className="animate-spin" />
              ) : (
                <IconLogin stroke={2.3} />
              )}
              {connecting
                ? t("settings.integrations.waitingForAuth")
                : t("settings.integrations.connect")}
            </Button>
            {connecting && (
              <Button variant="ghost" onClick={cancel}>
                {t("common.cancel")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Group>
  );
}

/* ------------------------------------------------------------------ */
/* Discord Rich Presence                                               */
/* ------------------------------------------------------------------ */

const DISCORD_DEVELOPER_PORTAL_URL =
  "https://discord.com/developers/applications";

function DiscordGroup() {
  const t = useT();
  const {
    enabled,
    applicationId,
    presenceName,
    activityType,
    showTitle,
    showArtist,
    showAlbumArt,
    showAlbumName,
    showTimestamps,
    showButton,
    onlySongs,
    hideWhenPaused,
    setEnabled,
    setApplicationId,
    setPresenceName,
    setActivityType,
    setShowTitle,
    setShowArtist,
    setShowAlbumArt,
    setShowAlbumName,
    setShowTimestamps,
    setShowButton,
    setOnlySongs,
    setHideWhenPaused,
  } = useDiscordStore();
  const configured = isDiscordConfigured({ enabled, applicationId });

  // Buffered like the Last.fm key/secret inputs above — commit on blur
  // rather than on every keystroke, since each committed change triggers a
  // reconnect attempt to Discord's IPC socket.
  const [idInput, setIdInput] = useState(applicationId);
  const commitId = () => setApplicationId(idInput);

  return (
    <Group>
      <SettingRow
        icon={IconMessageCircleFilled}
        settingId="discord"
        title={t("settings.integrations.discord")}
        description={t("settings.integrations.discordDesc")}
        control={
          <div className="flex shrink-0 items-center gap-2">
            <Badge
              variant={enabled ? "secondary" : "outline"}
              className={
                enabled && configured
                  ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
                  : undefined
              }
            >
              {!enabled
                ? t("settings.integrations.disabled")
                : configured
                  ? t("settings.integrations.enabled")
                  : t("settings.integrations.needsClientId")}
            </Badge>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={t("settings.integrations.enableDiscord")}
            />
          </div>
        }
      />
      {enabled && (
        <>
          <div className="flex flex-col gap-3 py-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="discord-client-id"
                className="text-sm font-medium"
              >
                {t("settings.integrations.clientId")}
              </label>
              <Input
                id="discord-client-id"
                value={idInput}
                onChange={(e) => setIdInput(e.target.value)}
                onBlur={commitId}
                onKeyDown={(e) => e.key === "Enter" && commitId()}
                placeholder={t("settings.integrations.clientId")}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-amber-600 dark:text-amber-500">
                {t("settings.integrations.clientIdHint")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => openUrl(DISCORD_DEVELOPER_PORTAL_URL)}
              className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {t("settings.integrations.createDiscordApp")}
              <IconExternalLink className="size-3" />
            </button>
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="discord-presence-name"
                className="text-sm font-medium"
              >
                {t("settings.integrations.presenceName")}
              </label>
              <Input
                id="discord-presence-name"
                value={presenceName}
                onChange={(e) => setPresenceName(e.target.value)}
                placeholder="YouTube Music"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.integrations.presenceNameHint")}
              </p>
            </div>
          </div>

          <SettingRow
            icon={IconActivity}
            settingId="activity-type"
            title={t("settings.integrations.activityType")}
            description={t("settings.integrations.activityTypeDesc")}
            control={
              <SegmentedControl
                value={activityType}
                onChange={setActivityType}
                options={[
                  {
                    value: "listening",
                    label: t("settings.integrations.listening"),
                  },
                  {
                    value: "playing",
                    label: t("settings.integrations.playing"),
                  },
                  {
                    value: "watching",
                    label: t("settings.integrations.watching"),
                  },
                ]}
              />
            }
          />
          <SettingRow
            icon={IconTypography}
            settingId="show-track-title"
            title={t("settings.integrations.showTrackTitle")}
            description={t("settings.integrations.showTrackTitleDesc")}
            control={
              <Switch
                checked={showTitle}
                onCheckedChange={setShowTitle}
                aria-label={t("settings.integrations.showTrackTitle")}
              />
            }
          />
          <SettingRow
            icon={IconMicrophoneFilled}
            settingId="show-artist"
            title={t("settings.integrations.showArtist")}
            description={t("settings.integrations.showArtistDesc")}
            control={
              <Switch
                checked={showArtist}
                onCheckedChange={setShowArtist}
                aria-label={t("settings.integrations.showArtist")}
              />
            }
          />
          <SettingRow
            icon={IconPhotoFilled}
            settingId="show-album-art"
            title={t("settings.integrations.showAlbumArt")}
            description={t("settings.integrations.showAlbumArtDesc")}
            control={
              <Switch
                checked={showAlbumArt}
                onCheckedChange={setShowAlbumArt}
                aria-label={t("settings.integrations.showAlbumArt")}
              />
            }
          />
          <SettingRow
            icon={IconDiscFilled}
            settingId="show-album-name"
            title={t("settings.integrations.showAlbumName")}
            description={t("settings.integrations.showAlbumNameDesc")}
            control={
              <Switch
                checked={showAlbumName}
                onCheckedChange={setShowAlbumName}
                aria-label={t("settings.integrations.showAlbumName")}
              />
            }
          />
          <SettingRow
            icon={IconClockFilled}
            settingId="show-elapsed-time"
            title={t("settings.integrations.showElapsedTime")}
            description={t("settings.integrations.showElapsedTimeDesc")}
            control={
              <Switch
                checked={showTimestamps}
                onCheckedChange={setShowTimestamps}
                aria-label={t("settings.integrations.showElapsedTime")}
              />
            }
          />
          <SettingRow
            icon={IconClickFilled}
            settingId="show-listen-button"
            title={t("settings.integrations.showListenButton")}
            description={t("settings.integrations.showListenButtonDesc")}
            control={
              <Switch
                checked={showButton}
                onCheckedChange={setShowButton}
                aria-label={t("settings.integrations.showListenButton")}
              />
            }
          />
          <SettingRow
            icon={IconFilterFilled}
            settingId="only-for-songs"
            title={t("settings.integrations.onlyForSongs")}
            description={t("settings.integrations.onlyForSongsDesc")}
            control={
              <Switch
                checked={onlySongs}
                onCheckedChange={setOnlySongs}
                aria-label={t("settings.integrations.onlyForSongs")}
              />
            }
          />
          <SettingRow
            icon={IconEyeOffFilled}
            settingId="hide-while-paused"
            title={t("settings.integrations.hideWhilePaused")}
            description={t("settings.integrations.hideWhilePausedDesc")}
            control={
              <Switch
                checked={hideWhenPaused}
                onCheckedChange={setHideWhenPaused}
                aria-label={t("settings.integrations.hideWhilePaused")}
              />
            }
          />
        </>
      )}
    </Group>
  );
}
