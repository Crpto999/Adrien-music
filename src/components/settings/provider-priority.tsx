import { useEffect, useState } from "react";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  PROVIDER_LABELS,
  type ProviderId,
} from "@/lib/providers/types";
import {
  getProviderOrder,
  setProviderOrder,
  subscribeProviderOrder,
} from "@/lib/providers/play";

/**
 * The reorderable provider priority list.
 *
 * The order decides which source serves a track when more than one of
 * them has it. It is a *pre-playback* choice: the app picks a source
 * that can play the track before any audio starts, so changing the
 * order here never interrupts a track that is already playing.
 */
export function ProviderPriorityList() {
  const t = useT();
  // Local mirror so the list re-renders on the change; the module
  // keeps the authoritative copy.
  const [order, setOrder] = useState<ProviderId[]>(getProviderOrder);

  // The order can also change elsewhere — another tab, a restored
  // session — so the mirror follows the module rather than drifting
  // away from it.
  useEffect(
    () => subscribeProviderOrder(() => setOrder(getProviderOrder())),
    [],
  );

  const move = (index: number, delta: number) => {
    const next = order.slice();
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setOrder(next);
    setProviderOrder(next);
  };

  return (
    <div className="flex flex-col gap-1 pb-4">
      <p className="text-[12.5px] leading-snug text-t7">
        {t("settings.providers.priorityHint")}
      </p>
      <ul className="mt-2 flex flex-col divide-y divide-w060">
        {order.map((provider, i) => (
          <li key={provider} className="flex items-center gap-3 py-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-w050 text-[11px] font-semibold text-t5">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-t2">
              {PROVIDER_LABELS[provider]}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={i === 0}
              onClick={() => move(i, -1)}
              aria-label={`${t("action.moveUp")} ${PROVIDER_LABELS[provider]}`}
              className={cn(i === 0 && "opacity-30")}
            >
              <IconArrowUp className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={i === order.length - 1}
              onClick={() => move(i, 1)}
              aria-label={`${t("action.moveDown")} ${PROVIDER_LABELS[provider]}`}
              className={cn(i === order.length - 1 && "opacity-30")}
            >
              <IconArrowDown className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
