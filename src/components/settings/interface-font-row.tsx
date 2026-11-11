import { useState } from "react";
import {
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconLoader2,
  IconTrash,
  IconTypography,
} from "@tabler/icons-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SettingRow } from "@/components/settings/primitives";
import { INTERFACE_FONTS, interfaceFontStack } from "@/lib/interface-font";
import {
  PINGFANG_TOTAL_BYTES,
  installPingfang,
  uninstallPingfang,
  usePingfangStore,
} from "@/lib/pingfang-font";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/store/settings";

/** A size in MB, for the download prompt. */
function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/**
 * The Interface font row.
 *
 * Two typefaces: the system stack and PingFang SC. The second one is
 * not bundled — it is 37 MB of font files, most of which most installs
 * never look at. So picking it does not switch the typeface straight
 * away: the user is told how big the download is and asked to confirm
 * it first. The download then happens in the background, with the
 * progress shown in the same dialog.
 */
export function InterfaceFontRow() {
  const t = useT();
  const font = useSettingsStore((s) => s.interfaceFont);
  const setFont = useSettingsStore((s) => s.setInterfaceFont);

  const status = usePingfangStore((s) => s.status);
  const loaded = usePingfangStore((s) => s.loaded);
  const total = usePingfangStore((s) => s.total);
  const error = usePingfangStore((s) => s.error);

  // The confirmation dialog, open only when the family is missing.
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const current = INTERFACE_FONTS.find((f) => f.id === font);
  const installed = status === "ready";
  const downloading = status === "downloading";

  const choose = (id: "system" | "pingfang") => {
    if (id === "pingfang" && !installed) {
      setAsking(true);
      return;
    }
    setFont(id);
  };

  const download = async () => {
    setBusy(true);
    try {
      const ok = await installPingfang();
      if (!ok) {
        toast.error(
          t("settings.appearance.fontPingfangFailed", {
            error: t("common.unknown"),
          }),
        );
        return;
      }
      setFont("pingfang");
      setAsking(false);
      toast.success(t("settings.appearance.fontPingfangDownloaded"));
    } catch (e) {
      toast.error(
        t("settings.appearance.fontPingfangFailed", { error: String(e) }),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await uninstallPingfang();
    // The typeface is gone, so the selection has to fall back to the
    // system stack rather than leave the app pointing at a font that
    // is no longer there.
    if (font === "pingfang") setFont("system");
    toast.success(t("settings.appearance.fontPingfangRemove"));
  };

  const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;

  return (
    <>
      <SettingRow
        icon={IconTypography}
        settingId="interface-font"
        title={t("settings.appearance.interfaceFont")}
        description={t("settings.appearance.interfaceFontDesc")}
        control={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 w-[196px] cursor-pointer items-center gap-2 rounded-[10px] border border-w090 bg-w040 px-3 text-[13px] text-t2 transition-colors duration-[140ms] hover:bg-w070 data-[state=open]:border-w200"
                style={{ fontFamily: interfaceFontStack(font) }}
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  {current?.label ?? t("settings.appearance.fontSystem")}
                </span>
                <IconChevronDown className="size-3 shrink-0 text-t6" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[232px]">
              {INTERFACE_FONTS.map((f) => (
                <DropdownMenuItem
                  key={f.id}
                  onSelect={() => choose(f.id)}
                  style={{ fontFamily: f.stack }}
                >
                  <span className="flex-1 truncate">{f.label}</span>
                  {f.id === "pingfang" && !installed ? (
                    <IconDownload className="size-3.5 shrink-0 text-t8" />
                  ) : null}
                  {font === f.id ? (
                    <IconCheck className="size-4 text-active!" stroke={2.4} />
                  ) : null}
                </DropdownMenuItem>
              ))}

              {installed ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void remove()}
                  >
                    <IconTrash className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {t("settings.appearance.fontPingfangRemove")}
                    </span>
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {/* The download confirmation. Shown when the user picks PingFang
          SC and the family is not on disk yet. */}
      <Dialog open={asking} onOpenChange={(v) => !busy && setAsking(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("settings.appearance.fontPingfang")}
            </DialogTitle>
            <DialogDescription>
              {t("settings.appearance.fontPingfangDesc", {
                size: formatSize(PINGFANG_TOTAL_BYTES),
              })}
            </DialogDescription>
          </DialogHeader>

          {downloading || busy ? (
            <div className="flex flex-col gap-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-w090">
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-300"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span className="text-xs text-t7">
                {t("settings.appearance.fontPingfangDownloading", {
                  percent: String(percent),
                })}
              </span>
            </div>
          ) : null}

          {error ? (
            <p className="text-xs text-status-error">
              {t("settings.appearance.fontPingfangFailed", { error })}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAsking(false)}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void download()} disabled={busy}>
              {busy || downloading ? (
                <IconLoader2 className="animate-spin" />
              ) : (
                <IconDownload />
              )}
              {t("settings.appearance.fontPingfangDownload", {
                size: formatSize(PINGFANG_TOTAL_BYTES),
              })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
