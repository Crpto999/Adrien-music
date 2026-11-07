import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityHeaderConfig } from "@/lib/store/entity-header";
import { useLocaleStore } from "@/lib/store/locale";
import { EntityPageHeader } from "./entity-page-header";

const state = vi.hoisted(() => ({
  config: null as EntityHeaderConfig | null,
  setHeaderHeight: vi.fn(),
}));

// SSR does not run the scroll/ResizeObserver effect. Supply the route's
// published snapshot directly, rather than relying on Zustand's SSR snapshot.
vi.mock("@/lib/store/entity-header", () => ({
  useEntityHeaderStore: (selector: (value: typeof state) => unknown) =>
    selector(state),
}));

function renderHeader() {
  return renderToStaticMarkup(createElement(EntityPageHeader));
}

describe("entity hero artwork enlargement", () => {
  beforeEach(() => {
    // The app ships with Simplified Chinese as its default locale, but
    // this test asserts on English strings — pin the locale.
    useLocaleStore.setState({ locale: "en" });
    state.config = {
      title: "Album title",
      thumbnails: [{ url: "https://example.com/cover.jpg", width: 512 }],
      round: false,
    };
  });

  it("provides a keyboard-accessible dialog button when the album opts in", () => {
    state.config!.enlargeCover = true;
    const html = renderHeader();
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Enlarge artwork for Album title"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("focus-visible:outline-2");
    expect(html).toContain('src="https://example.com/cover.jpg"');
  });

  it("leaves other entity artwork non-interactive by default", () => {
    expect(renderHeader()).not.toContain('aria-haspopup="dialog"');
  });

  it("does not overlay custom cover controls", () => {
    state.config!.enlargeCover = true;
    state.config!.cover = createElement("button", null, "Choose cover");
    const html = renderHeader();
    expect(html).toContain("Choose cover");
    expect(html).not.toContain('aria-haspopup="dialog"');
  });

  it("does not offer enlargement for missing artwork", () => {
    state.config!.enlargeCover = true;
    state.config!.thumbnails = [];
    expect(renderHeader()).not.toContain('aria-haspopup="dialog"');
  });

  it("preserves the other hero controls", () => {
    state.config!.enlargeCover = true;
    state.config!.onPlay = vi.fn();
    state.config!.onShuffle = vi.fn();
    state.config!.actions = createElement("button", null, "Album menu");
    state.config!.subtitle = createElement("a", { href: "/artist/123" }, "Artist");
    const html = renderHeader();
    expect(html).toContain("Play");
    expect(html).toContain("Shuffle");
    expect(html).toContain("Album menu");
    expect(html).toContain('href="/artist/123"');
  });
});
