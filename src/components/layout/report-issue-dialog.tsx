import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IconX } from "@tabler/icons-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  frostedDialogOverlay,
  frostedDialogPanel,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const REPO_ISSUES_URL = "https://github.com/Crpto999/Adrien-music/issues/new";

/**
 * Feedback form that hands off to GitHub: Submit opens a prefilled
 * new-issue page in the default browser with the app version and OS
 * appended, so reports arrive with the diagnostics we always ask for.
 * Voting/discussion happens on GitHub — no backend of our own.
 *
 * Lives in its own file because it is no longer owned by the title bar:
 * the app menu that used to open it moved to the sidebar's logo menu.
 */
export function ReportIssueDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!open) {
      setTitle("");
      setBody("");
    }
  }, [open]);

  const submit = async () => {
    if (!body.trim()) return;
    let version = "unknown";
    try {
      version = await getVersion();
    } catch {
      /* non-Tauri context (plain vite dev) — keep "unknown" */
    }
    const fullBody = [
      body.trim(),
      "",
      "---",
      `App version: ${version}`,
      `OS: ${navigator.userAgent}`,
    ].join("\n");
    const params = new URLSearchParams({ body: fullBody });
    if (title.trim()) params.set("title", title.trim());
    try {
      await openUrl(`${REPO_ISSUES_URL}?${params}`);
      toast.success(t("toast.reportThanks"));
      onOpenChange(false);
    } catch (e) {
      toast.error(t("toast.couldNotOpenBrowser"), {
        description: String(e),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={frostedDialogOverlay}
        className={cn(
          "w-[560px] max-w-[calc(100vw-2rem)] gap-4 rounded-2xl px-[26px] pb-[22px] pt-6 shadow-[0_30px_70px_-20px_var(--k850)] sm:max-w-[560px]",
          frostedDialogPanel,
        )}
      >
        {/* Catch-light along the top edge, as on the other dialogs. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-px top-0 h-px bg-[linear-gradient(90deg,transparent,var(--w160),transparent)]"
        />
        <DialogClose className="absolute right-4 top-4 z-[2] grid size-7 cursor-pointer place-items-center rounded-lg border border-w070 bg-w030 text-t6 transition-colors duration-[140ms] hover:bg-w080 hover:text-t2">
          <IconX className="size-3" />
          <span className="sr-only">{t("common.close")}</span>
        </DialogClose>

        {/* Right padding clears the close button. */}
        <DialogHeader className="gap-2 pr-[34px]">
          <DialogTitle className="text-2xl font-bold leading-none tracking-[-0.02em] text-t1">
            {t("report.title")}
          </DialogTitle>
          <DialogDescription className="text-[13.5px] leading-[1.5] text-t4 text-pretty">
            {t("report.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("report.summaryPlaceholder")}
          />
          {/* Same surface as `Input`, minus its fixed height. */}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("report.bodyPlaceholder")}
            rows={7}
            className="w-full resize-none rounded-lg border border-w120 bg-w050 px-3 py-3 text-[13.5px] leading-[1.5] text-t2 outline-none transition-[background-color,border-color,box-shadow] duration-[140ms] placeholder:text-tph hover:border-w200 hover:bg-w080 focus-visible:border-acc1 focus-visible:bg-w070 focus-visible:ring-[3px] focus-visible:ring-[rgba(var(--acc1rgb),0.18)]"
          />
        </div>

        <DialogFooter className="gap-2.5 pt-0.5">
          <Button
            variant="secondary"
            size="lg"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button size="lg" onClick={() => void submit()} disabled={!body.trim()}>
            {t("report.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
