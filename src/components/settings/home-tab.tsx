import { useState } from "react";
import {
  IconEye,
  IconEyeOff,
  IconGripVertical,
  IconHomeFilled,
  IconRestore,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { useHomeSectionsStore } from "@/lib/store/home-sections";
import { useLocale, useT } from "@/lib/i18n";
import { homeSectionLabel } from "@/lib/i18n/home-sections";
import { cn } from "@/lib/utils";

/**
 * The Home page's shelves (Listen again, Quick picks, etc.).
 *
 * Two independent controls live here:
 *
 *   1. **Order** — drag a row to move it. The home feed carries no
 *      stable id per shelf — only a title string — so
 *      `useHomeSectionsStore` keys the saved order on that (see the
 *      store for the full rationale). Reordering flips `customized` on,
 *      which makes the Home route eager-load every page before
 *      rendering, so a section ranked first always appears first even
 *      if the API happened to place it on a later page.
 *
 *   2. **Visibility** — shield a section the user does not want to see
 *      at all. A shielded section keeps its place in the order (so
 *      un-shielding puts it back exactly where it was) but the Home
 *      route skips it. Two ways to do it: the eye button on the row, or
 *      dragging the row onto the shield zone below the list — the
 *      gesture the user asked for, and the faster one when a whole
 *      group of rows is unwanted.
 *
 * Visibility deliberately does *not* flip `customized`: shielding a
 * section changes no order, so it must not drag the home feed into
 * its eager-load-every-page mode.
 */
export function HomeTab() {
  const t = useT();
  const locale = useLocale();
  const order = useHomeSectionsStore((s) => s.order);
  const hidden = useHomeSectionsStore((s) => s.hidden);
  const reorder = useHomeSectionsStore((s) => s.reorder);
  const toggleHidden = useHomeSectionsStore((s) => s.toggleHidden);
  const resetToDefault = useHomeSectionsStore((s) => s.resetToDefault);
  const customized = useHomeSectionsStore((s) => s.customized);

  // Same native-HTML5-drag pattern as the queue panel's reorderable
  // list (`queue-panel.tsx`) — no drag-and-drop library in this repo.
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  // The shield zone lights up while a row is dragged over it.
  const [overShield, setOverShield] = useState(false);

  // The visible sections, in the user's order. The shielded ones are
  // listed separately below so they can be brought back.
  const visible = order.filter((key) => !hidden.includes(key));
  const shielded = order.filter((key) => hidden.includes(key));

  const dirty = customized || hidden.length > 0;

  return (
    <TabPane>
      <Group>
        <SettingRow
          icon={IconHomeFilled}
          settingId="section-order"
          title={t("settings.home.sectionOrder")}
          description={t("settings.home.sectionOrderDesc")}
          control={
            dirty ? (
              <Button variant="ghost" size="sm" onClick={resetToDefault}>
                {t("common.reset")}
              </Button>
            ) : undefined
          }
        />
      </Group>

      <div className="flex flex-col gap-0.5 pt-4">
        {visible.map((key) => {
          const i = order.indexOf(key);
          return (
            <HomeSectionRow
              key={key}
              title={homeSectionLabel(key, locale)}
              isDragging={dragFrom === i}
              isDropTarget={dragOver === i && dragFrom !== i}
              onDragStart={() => setDragFrom(i)}
              onDragOver={() => {
                if (dragFrom === null) return;
                setDragOver(i);
              }}
              onDrop={() => {
                if (dragFrom !== null && dragFrom !== i) {
                  // Same "insert before the hovered row" math as the
                  // queue panel: splicing the dragged item out first
                  // shifts a downward target's index down by one.
                  const to = dragFrom < i ? i - 1 : i;
                  reorder(dragFrom, to);
                }
                setDragFrom(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              onToggleVisibility={() => toggleHidden(key)}
            />
          );
        })}
      </div>

      {/* The shield zone. Dragging a section onto it hides that
          section — the same gesture the eye button performs, for
          anyone who finds dragging more natural than hunting for the
          small button. It only appears while a row is being dragged,
          so it never competes with the list itself. */}
      {dragFrom !== null ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOverShield(true);
          }}
          onDragLeave={() => setOverShield(false)}
          onDrop={(e) => {
            e.preventDefault();
            if (dragFrom !== null) {
              toggleHidden(order[dragFrom]);
            }
            setDragFrom(null);
            setDragOver(null);
            setOverShield(false);
          }}
          className={cn(
            "mt-3 flex items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-4 text-[12.5px] transition-colors",
            overShield
              ? "border-brand bg-brand/10 text-foreground"
              : "border-w070 text-t7",
          )}
        >
          <IconEyeOff className="size-4 shrink-0" />
          {t("settings.home.dropToHide")}
        </div>
      ) : null}

      {/* The shielded sections, listed so they can be brought back.
          Kept out of the drag list on purpose: a shielded section has
          no place in the visible order, and letting it be dragged would
          make "reorder" and "restore" the same gesture. */}
      {shielded.length > 0 ? (
        <div className="flex flex-col gap-0.5 pt-4">
          <p className="px-2 pb-1 text-[12.5px] text-t7">
            {t("settings.home.shielded")}
          </p>
          {shielded.map((key) => (
            <div
              key={key}
              className="flex items-center gap-2 rounded-md bg-w050 px-2 py-2"
            >
              <IconEyeOff className="size-4 shrink-0 text-t7" />
              <span className="min-w-0 flex-1 truncate text-sm text-t7 line-through">
                {homeSectionLabel(key, locale)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => toggleHidden(key)}
              >
                <IconRestore className="size-3.5" />
                {t("settings.home.restore")}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </TabPane>
  );
}

function HomeSectionRow({
  title,
  isDragging,
  isDropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onToggleVisibility,
}: {
  title: string;
  isDragging: boolean;
  isDropTarget: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onToggleVisibility: () => void;
}) {
  const t = useT();
  return (
    <div
      draggable
      onDragStart={(e) => {
        // Some browsers refuse to start a drag without a dataTransfer
        // payload.
        e.dataTransfer.setData("text/plain", title);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group relative flex items-center gap-2 rounded-md px-2 py-2 select-none",
        "cursor-grab active:cursor-grabbing hover:bg-accent/60",
        isDragging && "opacity-40",
        isDropTarget &&
          "before:pointer-events-none before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-brand",
      )}
    >
      <IconGripVertical className="size-4 shrink-0 text-muted-foreground/60" />
      <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onToggleVisibility}
        aria-label={t("settings.home.hideSection")}
        title={t("settings.home.hideSection")}
        className="shrink-0 text-t7 hover:text-foreground"
      >
        <IconEye className="size-4" />
      </Button>
    </div>
  );
}
