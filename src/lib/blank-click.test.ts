import { describe, expect, it } from "vitest";
import { isBlankClick } from "./blank-click";

/**
 * The blank-click rule decides whether a click on the player card, the
 * bottom bar or the full-screen sheet means "open / close the
 * full-screen view" or "I meant to press that control".
 *
 * The helper is duck-typed on purpose (no `instanceof HTMLElement`),
 * so these tests exercise the rule without needing a DOM.
 */

/** A minimal stand-in for the parts of an element the helper uses. */
function element(
  matches: (selector: string) => boolean,
  text: string | null = null,
): EventTarget {
  const childNodes = text === null ? [] : [{ nodeType: 3, textContent: text }];
  return {
    // The real `closest` takes the whole comma-separated selector
    // list; the mock splits it so a matcher can name one entry.
    closest: (selector: string) =>
      selector
        .split(",")
        .map((s) => s.trim())
        .some((s) => matches(s))
        ? {}
        : null,
    childNodes,
  } as unknown as EventTarget;
}

/** Matches nothing — a plain blank surface. */
const blank = () => false;

describe("blank-click detection", () => {
  it("treats a surface with no text and no control as blank", () => {
    expect(isBlankClick(element(blank))).toBe(true);
  });

  it("rejects a target inside a control", () => {
    // Any selector in the interactive list matching means "not blank".
    expect(isBlankClick(element((s) => s === "button"))).toBe(false);
    expect(isBlankClick(element((s) => s.includes("slider")))).toBe(false);
    expect(isBlankClick(element((s) => s.includes("data-blank-exclude")))).toBe(
      false,
    );
  });

  it("rejects a target that carries its own text", () => {
    // A title, an artist name, a timestamp — content, not blank space.
    expect(isBlankClick(element(blank, "Song Title"))).toBe(false);
  });

  it("ignores whitespace-only text", () => {
    expect(isBlankClick(element(blank, "   \n "))).toBe(true);
  });

  it("rejects anything that is not an element", () => {
    expect(isBlankClick(null)).toBe(false);
    expect(isBlankClick({} as EventTarget)).toBe(false);
    expect(isBlankClick("text" as unknown as EventTarget)).toBe(false);
  });
});
