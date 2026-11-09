/**
 * Deciding whether a click landed on empty surface.
 *
 * The player card, the bottom bar and the full-screen view all treat a
 * click on their blank surface as "open / close the full-screen view".
 * That is only safe if the click did NOT land on something the user
 * meant to operate — a button, a link, a slider thumb, a lyric line,
 * a menu row.
 *
 * Two checks, both cheap:
 *
 * 1. Is the target inside an interactive element? Radix and our own
 *    components mark these with roles or `data-slot`s, so a single
 *    selector covers them.
 * 2. Does the target itself carry text? Text is content, not blank
 *    space — clicking a song title should not blow the view open.
 *    The check looks at the element's OWN text nodes only: an
 *    ancestor's text says nothing about the spot that was clicked,
 *    and using it would make every container look non-blank (the
 *    card's own text would disqualify its padding).
 */

/**
 * The selectors that mark a control.
 *
 * Kept as one list so the rule is easy to audit: anything the user can
 * operate belongs here, or a click on it would open the full-screen
 * view by accident.
 */
const INTERACTIVE = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "video",
  "audio",
  "canvas",
  "iframe",
  "[contenteditable='true']",
  "[role='button']",
  "[role='slider']",
  "[role='tab']",
  "[role='radio']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='listbox']",
  "[role='combobox']",
  "[data-slot='slider']",
  "[data-slot='select']",
  "[data-slot='context-menu']",
  "[data-slot='dropdown-menu']",
  "[data-slot='popover']",
  "[data-slot='tooltip']",
  "[data-slot='dialog']",
  "[data-slot='context-menu-trigger']",
  // Opt-out for regions that are not blank but are not controls
  // either — the queue list, the lyrics column.
  "[data-blank-exclude]",
].join(", ");

/** The DOM's text-node type. Spelled out so this module does not
 *  depend on the `Node` global (which is absent outside a browser). */
const TEXT_NODE = 3;

/**
 * The element shape this module needs. Duck-typed rather than checked
 * with `instanceof HTMLElement`, so the rule stays testable without a
 * DOM and works for SVG elements too.
 */
type ClickTarget = {
  closest: (selector: string) => unknown;
  childNodes: {
    readonly length: number;
    [index: number]: { nodeType: number; textContent: string | null };
  };
};

function asTarget(target: EventTarget | null): ClickTarget | null {
  if (typeof target !== "object" || target === null) return null;
  const candidate = target as Partial<ClickTarget>;
  if (typeof candidate.closest !== "function") return null;
  if (!candidate.childNodes) return null;
  return candidate as ClickTarget;
}

/**
 * True when the click landed on empty surface — the click target is
 * not inside a control and carries no text of its own.
 */
export function isBlankClick(target: EventTarget | null): boolean {
  const element = asTarget(target);
  if (!element) return false;
  if (element.closest(INTERACTIVE)) return false;
  for (let i = 0; i < element.childNodes.length; i++) {
    const node = element.childNodes[i];
    if (node.nodeType === TEXT_NODE && node.textContent?.trim()) {
      return false;
    }
  }
  return true;
}
