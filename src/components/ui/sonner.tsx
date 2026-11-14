import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconInfoCircle,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useLayoutStore } from "@/lib/store/layout";
import { useThemeScheme } from "@/lib/theme";

/**
 * Toasts, per the design handoff.
 *
 * `unstyled` drops sonner's own look wholesale: every rule it ships is
 * gated on `[data-styled=true]`, so turning that off leaves only the
 * stacking transforms and enter/exit animation, which already match the
 * prototype (collapsed stack, each card behind scaled down and dimmed).
 * Everything visual below is ours.
 *
 * The card is a frosted 304px sheet. Sonner sizes the list from
 * `--width`, so the card takes `w-full` and the width is set once on the
 * list instead of fighting it per toast.
 */
const TOAST =
  "group pointer-events-auto flex w-full items-center gap-3 rounded-xl border " +
  "border-w090 bg-glass2 p-3 backdrop-blur-[26px] backdrop-saturate-150 " +
  "shadow-[0_18px_42px_-14px_var(--k850)] " +
  // Errors carry their own tint rather than only a red icon: a flat red
  // wash over the same glass, a red border, and a catch-light on top.
  // The hue comes from the status token, so the toast follows the
  // theme's error colour instead of a hard-coded red.
  "data-[type=error]:border-status-error/35 " +
  "data-[type=error]:bg-[linear-gradient(0deg,rgba(var(--status-error-rgb),0.13),rgba(var(--status-error-rgb),0.13)),var(--glass2)] " +
  "data-[type=error]:shadow-[0_18px_42px_-14px_var(--k850),inset_0_1px_0_var(--w060)]";

/**
 * The 32px icon tile. Neutral by default; success goes green-on-tint,
 * error inverts to white on solid red so it reads as the loudest thing
 * in the stack.
 *
 * The four status hues are the spec's function colours, taken from the
 * status tokens rather than spelled out, so they stay consistent with
 * the rest of the app and follow the theme.
 */
const ICON =
  "grid size-8 shrink-0 place-items-center rounded-[10px] bg-w080 text-t3 " +
  "group-data-[type=success]:bg-status-success/15 group-data-[type=success]:text-status-success " +
  "group-data-[type=warning]:bg-status-warning/15 group-data-[type=warning]:text-status-warning " +
  "group-data-[type=info]:bg-status-info/15 group-data-[type=info]:text-status-info " +
  "group-data-[type=error]:bg-status-error group-data-[type=error]:text-status-error-foreground";

const BUTTON =
  "shrink-0 cursor-pointer rounded-md bg-w060 px-[9px] py-1 text-[11.5px] " +
  "font-semibold transition-colors duration-[140ms] hover:bg-w090";

const Toaster = ({ ...props }: ToasterProps) => {
  const scheme = useThemeScheme();
  // The stack has to dodge the player: with the bottom bar it would land
  // right on top of it, so it moves to the opposite corner. Side card and
  // floating both leave the bottom of the page free.
  const bottomBar = useLayoutStore((s) => s.mode === "bottom");

  return (
    <Sonner
      theme={scheme}
      position={bottomBar ? "top-right" : "bottom-center"}
      // Top right has to start below the title bar, otherwise the first
      // card sits under the window controls.
      offset={
        bottomBar ? { top: "calc(var(--titlebar-h) + 12px)", right: 20 } : 20
      }
      className="toaster group"
      icons={{
        success: <IconCheck className="size-4" stroke={2.4} />,
        info: <IconInfoCircle className="size-4" />,
        warning: <IconAlertTriangle className="size-4" />,
        error: <IconAlertCircle className="size-4" stroke={2.1} />,
        loading: <IconLoader2 className="size-4 animate-spin" />,
        close: <IconX className="size-3" />,
      }}
      closeButton
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: TOAST,
          icon: ICON,
          content: "flex min-w-0 flex-1 flex-col gap-[3px]",
          // Truncated, not wrapped: playlist and track names arrive as
          // one unbroken token often enough that wrapping tore the card
          // into three ragged lines.
          title:
            "truncate text-[13px] font-semibold tracking-[-0.008em] text-t1",
          // An error message is the one case where the FULL text
          // matters: "command relink_account not found" was cut off
          // after "command relink" and the missing half was the whole
          // diagnosis. The title stays truncated (it carries the
          // headline), the description wraps.
          description:
            "line-clamp-6 break-words text-[11.5px] leading-[1.35] text-t5",
          actionButton: `${BUTTON} text-t2`,
          cancelButton: `${BUTTON} text-t6`,
          // Sonner renders the close button first in the DOM, where it
          // would land ahead of the icon in a flex row.
          closeButton:
            "order-last grid size-7 shrink-0 cursor-pointer place-items-center rounded-md " +
            "text-t7 transition-colors duration-[140ms] hover:bg-w090 hover:text-t2",
        },
      }}
      style={{ "--width": "304px" } as React.CSSProperties}
      {...props}
    />
  );
};

export { Toaster };
