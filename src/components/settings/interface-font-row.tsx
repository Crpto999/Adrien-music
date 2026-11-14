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
import {
  NOTO_SANS_SC_TOTAL_BYTES,
  installNotoSansSc,
  uninstallNotoSansSc,
  useNotoSansScStore,
} from "@/lib/noto-sans-sc-font";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/store/settings";

/** A size in MB, for the download prompt. */
function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/**
 * The Interface font row.
 *
 * Three typefaces: the system stack, PingFang SC and Noto Sans SC.
 * The latter two are not bundled — they are tens of megabytes of font
 * files, most of which most installs never look at. So picking one
 * does not switch the typeface straight away: the user is told how big
 * the download is and asked to confirm it first. The download then
 * happens in the background, with the progress shown in the same
 * dialog.
 */
export function InterfaceFontRow() {
  const t = useT();
  const font = useSettingsStore((s) => s.interfaceFont);
  const setFont = useSettingsStore((s) => s.setInterfaceFont);

  const pingfang = usePingfangStore();
  const noto = useNotoSansScStore();

  // The confirmation dialog, open only when the family is missing. It
  // names the family, so the pending pick is kept rather than a bare
  // boolean.
  const [asking, setAsking] = useState<"pingfang" | "noto-sans-sc" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const current = INTERFACE_FONTS.find((f) => f.id === font);

  /**
   * The state of the family the dialog is about, and the operations on
   * it. The two downloadable families are handled by the same code, so
   * the row does not carry a branch per family.
   */
  const pending = asking === "pingfang" ? "pingfang" : "noto-sans-sc";
  const state = asking === "pingfang" ? pingfang : noto;
  const downloading = state.status === "downloading";
  const totalBytes =
    asking === "pingfang" ? PINGFANG_TOTAL_BYTES : NOTO_SANS_SC_TOTAL_BYTES;

  const choose = (id: "system" | "pingfang" | "noto-sans-sc") => {
    if (id === "pingfang" && pingfang.status !== "ready") {
      setAsking("pingfang");
      return;
    }
    if (id === "noto-sans-sc" && noto.status !== "ready") {
      setAsking("noto-sans-sc");
      return;
    }
    setFont(id);
  };

  const download = async () => {
    setBusy(true);
    try {
      const ok =
        pending === "pingfang"
          ? await installPingfang()
          : await installNotoSansSc();
      if (!ok) {
        toast.error(
          t("settings.appearance.fontDownloadFailed", {
            error: t("common.unknown"),
          }),
        );
        return;
      }
      setFont(pending);
      setAsking(null);
      toast.success(t("settings.appearance.fontDownloaded"));
    } catch (e) {
      toast.error(
        t("settings.appearance.fontDownloadFailed", { error: String(e) }),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: "pingfang" | "noto-sans-sc") => {
    if (id === "pingfang") await uninstallPingfang();
    else await uninstallNotoSansSc();
    // The typeface is gone, so the selection has to fall back to the
    // system stack rather than leave the app pointing at a font that
    // is no longer there.
    if (font === id) setFont("system");
    toast.success(t("settings.appearance.fontRemove"));
  };

  const percent =
    state.total > 0 ? Math.round((state.loaded / state.total) * 100) : 0;

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
                  {f.id !== "system" &&
                  (f.id === "pingfang"
                    ? pingfang.status !== "ready"
                    : noto.status !== "ready") ? (
                    <IconDownload className="size-3.5 shrink-0 text-t8" />
                  ) : null}
                  {font === f.id ? (
                    <IconCheck className="size-4 text-active!" stroke={2.4} />
                  ) : null}
                </DropdownMenuItem>
              ))}

              {pingfang.status === "ready" || noto.status === "ready" ? (
                <>
                  <DropdownMenuSeparator />
                  {pingfang.status === "ready" ? (
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => void remove("pingfang")}
                    >
                      <IconTrash className="size-3.5 shrink-0" />
                      <span className="truncate">
                        {t("settings.appearance.fontRemove")}
                      </span>
                    </DropdownMenuItem>
                  ) : null}
                  {noto.status === "ready" ? (
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => void remove("noto-sans-sc")}
                    >
                      <IconTrash className="size-3.5 shrink-0" />
                      <span className="truncate">
                        {t("settings.appearance.fontRemove")}
                      </span>
                    </DropdownMenuItem>
                  ) : null}
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {/* The download confirmation. Shown when the user picks a
          downloadable family and it is not on disk yet. */}
      <Dialog
        open={asking !== null}
        onOpenChange={(v) => !busy && setAsking(v ? asking : null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pending === "pingfang"
                ? t("settings.appearance.fontPingfang")
                : t("settings.appearance.fontNotoSansSc")}
            </DialogTitle>
            <DialogDescription>
              {t("settings.appearance.fontDownloadDesc", {
                size: formatSize(totalBytes),
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
                {t("settings.appearance.fontDownloading", {
                  percent: String(percent),
                })}
              </span>
            </div>
          ) : null}

          {state.error ? (
            <p className="text-xs text-status-error">
              {t("settings.appearance.fontDownloadFailed", {
                error: state.error,
              })}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAsking(null)}
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
              {t("settings.appearance.fontDownload", {
                size: formatSize(totalBytes),
              })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
