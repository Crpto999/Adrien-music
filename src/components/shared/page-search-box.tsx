import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { IconHistory, IconSearch, IconX } from "@tabler/icons-react";

import { Input } from "@/components/ui/input";
import {
  MENU_ITEM,
  MENU_PANEL,
  MENU_SEPARATOR,
} from "@/components/ui/menu-chrome";
import { useSearchHistory } from "@/lib/store/search-history";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const HISTORY_LIMIT = 5;

/** How long the input has to stay quiet before the search runs. */
const DEBOUNCE_MS = 350;
/** Below this many characters the query is too vague to be worth a
 *  round trip — one letter would search for every single-character
 *  title on the platform. */
const MIN_QUERY_LEN = 2;

/**
 * The search box, as it appears on the Home and Library pages.
 *
 * It is the same field the Search page uses, but it lives on a page
 * that isn't the search page: typing here runs the search and lands
 * the user on the results. The query is debounced, so the navigation
 * happens once the typing pauses rather than on every keystroke, and
 * the Search page picks up from there with its own live results.
 *
 * The dropdown is the recent-search list, so a query the user has run
 * before can be picked with one click. It closes on blur unless the
 * click landed inside it.
 */
export function PageSearchBox({ className }: { className?: string }) {
  const t = useT();
  const navigate = useNavigate();

  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const history = useSearchHistory((s) => s.items);
  const pushHistory = useSearchHistory((s) => s.push);
  const clearHistory = useSearchHistory((s) => s.clear);

  // The navigation functions are read through refs so the debounce
  // below isn't restarted when the router hands out a new closure.
  const navRef = useRef(navigate);
  const pushRef = useRef(pushHistory);
  useEffect(() => {
    navRef.current = navigate;
    pushRef.current = pushHistory;
  }, [navigate, pushHistory]);

  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return history.slice(0, HISTORY_LIMIT);
    return history
      .filter((h) => h.toLowerCase().includes(q) && h.toLowerCase() !== q)
      .slice(0, HISTORY_LIMIT);
  }, [history, value]);

  useEffect(() => {
    setActiveIdx(-1);
  }, [suggestions.length, focused]);

  const showDropdown = focused && suggestions.length > 0;

  // Run the search once the typing pauses. The timer is cleared on
  // every keystroke, so only the final value of a burst of typing ever
  // reaches the router. Pushing to the history here (rather than only
  // on an explicit submit) keeps the recent-search list in step with
  // what the user actually searched for.
  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed.length < MIN_QUERY_LEN) return;
    const id = setTimeout(() => {
      pushRef.current(trimmed);
      navRef.current({ to: "/search", search: { q: trimmed } });
    }, DEBOUNCE_MS);
    pendingRef.current = id;
    return () => {
      clearTimeout(id);
      if (pendingRef.current === id) pendingRef.current = null;
    };
  }, [value]);

  // A pending auto-navigation must not outlive the box: the user may
  // have navigated away, and a timer firing into a dead component
  // would push a stray route entry.
  useEffect(() => {
    return () => {
      if (pendingRef.current) clearTimeout(pendingRef.current);
    };
  }, []);

  const submitQuery = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    // An explicit choice wins over the pending debounce.
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
    pushHistory(trimmed);
    setValue(trimmed);
    setFocused(false);
    inputRef.current?.blur();
    // Straight to the results: the box on Home / Library is an entry
    // point, so submitting always leaves the page it sits on.
    navigate({ to: "/search", search: { q: trimmed } });
  };

  const clear = () => {
    // Clearing the field cancels a pending search: the user asked to
    // start over, not to keep going with what they typed.
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
    setValue("");
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (value) {
        clear();
        return;
      }
      setFocused(false);
      inputRef.current?.blur();
      return;
    }
    if (!showDropdown) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    }
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (activeIdx >= 0 && suggestions[activeIdx]) {
            submitQuery(suggestions[activeIdx]);
          } else {
            submitQuery(value);
          }
        }}
      >
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          placeholder={t("search.placeholder")}
          className="pl-9 pr-9"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            if (
              containerRef.current?.contains(e.relatedTarget as Node | null)
            ) {
              return;
            }
            setFocused(false);
          }}
          onKeyDown={onKeyDown}
        />
        {value ? (
          <button
            type="button"
            aria-label={t("search.clear")}
            onClick={clear}
            className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-t5 transition-colors hover:bg-w070 hover:text-t1 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <IconX className="size-4" />
          </button>
        ) : null}
      </form>

      {showDropdown && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          className={cn(MENU_PANEL, "absolute inset-x-0 top-full mt-2 overflow-hidden")}
        >
          <ul>
            {suggestions.map((h, i) => (
              <li key={h}>
                <button
                  type="button"
                  className={cn(
                    MENU_ITEM,
                    "w-full text-left hover:bg-w070 hover:text-t1 hover:[&_svg:not([class*='text-'])]:text-t3",
                    i === activeIdx &&
                      "bg-w070 text-t1 [&_svg:not([class*='text-'])]:text-t3",
                  )}
                  onClick={() => submitQuery(h)}
                  onMouseEnter={() => setActiveIdx(i)}
                >
                  <IconHistory className="size-4" />
                  <span className="truncate">{h}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className={MENU_SEPARATOR} />
          <div>
            <button
              type="button"
              className={cn(
                MENU_ITEM,
                "w-full text-left text-xs text-t6 hover:bg-w070 hover:text-t1",
              )}
              onClick={() => {
                clearHistory();
                setFocused(false);
                inputRef.current?.blur();
              }}
            >
              {t("search.clearHistory")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
