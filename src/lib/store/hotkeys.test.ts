import { describe, expect, it } from "vitest";
import {
  buttonLabel,
  describeBinding,
  keyLabel,
  labelOf,
  sameBinding,
  type HotkeyBinding,
} from "./hotkeys";
import { toRustBindings } from "@/lib/global-hotkeys";

const key = (code: string, modifiers: string[] = []): HotkeyBinding => ({
  kind: "key",
  code,
  modifiers: modifiers as HotkeyBinding["modifiers"],
});

const mouse = (
  button: HotkeyBinding["button"],
  modifiers: string[] = [],
): HotkeyBinding => ({
  kind: "mouse",
  button,
  modifiers: modifiers as HotkeyBinding["modifiers"],
});

describe("sameBinding", () => {
  it("treats the same key and modifiers as the same shortcut", () => {
    expect(sameBinding(key("KeyP", ["ctrl"]), key("KeyP", ["ctrl"]))).toBe(true);
  });

  it("separates different keys", () => {
    expect(sameBinding(key("KeyP"), key("KeyQ"))).toBe(false);
  });

  it("separates different modifier sets", () => {
    expect(sameBinding(key("KeyP", ["ctrl"]), key("KeyP", ["ctrl", "shift"]))).toBe(
      false,
    );
  });

  it("separates a key from a mouse button", () => {
    expect(sameBinding(key("KeyP"), mouse("left"))).toBe(false);
  });

  it("compares mouse buttons too", () => {
    expect(sameBinding(mouse("left", ["alt"]), mouse("left", ["alt"]))).toBe(true);
    expect(sameBinding(mouse("left"), mouse("right"))).toBe(false);
  });
});

describe("describeBinding", () => {
  it("is empty for an unbound action", () => {
    expect(describeBinding(undefined)).toBe("");
  });

  it("renders a single key", () => {
    expect(describeBinding(key("KeyP"))).toBe("P");
  });

  it("renders a combination in a fixed modifier order", () => {
    // The order is the user's, not the order they were pressed in, so
    // the label reads the same every time.
    expect(describeBinding(key("KeyP", ["shift", "ctrl"]))).toBe("Ctrl + Shift + P");
  });

  it("renders a mouse button", () => {
    expect(describeBinding(mouse("middle"))).toBe("Middle Button");
  });
});

describe("keyLabel", () => {
  it("turns the physical key name into something readable", () => {
    expect(keyLabel("KeyP")).toBe("P");
    expect(keyLabel("Digit1")).toBe("1");
    expect(keyLabel("Space")).toBe("Space");
    expect(keyLabel("ArrowLeft")).toBe("←");
  });

  it("falls back to the raw name", () => {
    expect(keyLabel("F13")).toBe("F13");
    expect(keyLabel("")).toBe("");
  });
});

describe("labelOf / buttonLabel", () => {
  it("names the modifiers", () => {
    expect(labelOf("ctrl")).toBe("Ctrl");
    expect(labelOf("shift")).toBe("Shift");
    expect(labelOf("alt")).toBe("Alt");
    expect(labelOf("super")).toBe("Win");
  });

  it("names the mouse buttons", () => {
    expect(buttonLabel("left")).toBe("Left Button");
    expect(buttonLabel("back")).toBe("Back Button");
    expect(buttonLabel(undefined)).toBe("Mouse");
  });
});

describe("toRustBindings", () => {
  it("sends one flat entry per bound action", () => {
    const out = toRustBindings({
      toggle: key("Space"),
      like: mouse("middle", ["ctrl"]),
    });

    expect(out).toEqual([
      {
        action: "toggle",
        kind: "key",
        code: "Space",
        button: "",
        modifiers: [],
      },
      {
        action: "like",
        kind: "mouse",
        code: "",
        button: "middle",
        modifiers: ["ctrl"],
      },
    ]);
  });

  it("skips the unbound actions", () => {
    expect(toRustBindings({})).toEqual([]);
    expect(toRustBindings({ toggle: undefined })).toEqual([]);
  });
});
