import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { IconRefresh, IconQrcode } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";
import {
  cancelNeteaseLogin,
  type NeteaseQrCode,
  startNeteaseLogin,
} from "@/lib/providers/netease-auth";

/**
 * The NetEase QR-code sign-in.
 *
 * The backend draws the QR code locally and polls the platform for the
 * scan state, so this dialog has exactly one job: show the picture and
 * get out of the way. It closes itself the moment the sign-in lands —
 * the user has already confirmed on their phone by then, so there is
 * nothing left for them to do here.
 */
export function NeteaseLoginDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [qr, setQr] = useState<NeteaseQrCode | null>(null);

  // The sign-in succeeded — close, so the user is not left staring at a
  // QR code they have already used.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;

    void listen("netease-login-success", () => {
      if (!cancelled) onOpenChange(false);
    })
      .then((un) => {
        if (cancelled) un();
        else dispose = un;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [open, onOpenChange]);

  // A fresh code. The backend retires the previous attempt, so the old
  // code stops being polled for and the new one takes over.
  const refresh = useCallback(async () => {
    setQr(null);
    const next = await startNeteaseLogin();
    if (next) setQr(next);
  }, []);

  // Ask for the first code when the dialog opens. The code comes back
  // from the call itself, so there is no window in which it could
  // arrive before the dialog was listening for it.
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  // Closing the dialog gives up on the sign-in, so the backend stops
  // polling for a credential nobody is waiting for any more.
  const close = (next: boolean) => {
    if (!next) void cancelNeteaseLogin();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>{t("settings.integrations.neteaseQrTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.integrations.neteaseQrDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-center py-2">
          {qr ? (
            <img
              src={qr.image}
              alt={t("settings.integrations.neteaseQrAlt")}
              className="size-[240px] rounded-md bg-white p-2"
            />
          ) : (
            <div className="flex size-[240px] items-center justify-center rounded-md border border-dashed border-border">
              <IconQrcode className="size-10 text-muted-foreground" />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => close(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <IconRefresh stroke={2.3} />
            {t("settings.integrations.neteaseQrRefresh")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
