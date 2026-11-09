import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { clearLikeSyncCache, setNeteaseLikeSyncAvailable } from "@/lib/providers/netease-like";

/**
 * The NetEase account, as the backend reports it.
 *
 * `signedIn` is the whole story: the NetEase credential is what makes
 * the daily recommendation personal (the platform answers anonymously
 * with an empty list), and what tells the platform which tracks the
 * account may actually play.
 */
export type NeteaseSession = {
  signedIn: boolean;
  userId: string | null;
  nickname: string | null;
  avatarUrl: string | null;
};

/**
 * The current NetEase session.
 *
 * The query is the single source of truth for "is the user signed in
 * to NetEase". Every consumer — the settings row, the daily
 * recommendation shelf — reads it, so a sign-in or a sign-out updates
 * all of them at once.
 */
export function useNeteaseSession() {
  const query = useQuery({
    queryKey: ["netease-session"],
    queryFn: () => invoke<NeteaseSession>("netease_session"),
    staleTime: 60_000,
    retry: false,
  });

  // The heart sync needs to know whether there is an account to sync
  // to. It is recorded in a module-level flag rather than read from
  // the query inside the sync, because the sync runs from an action
  // handler that has no access to the query cache.
  setNeteaseLikeSyncAvailable(query.data?.signedIn === true);

  return query;
}

/**
 * Open the NetEase sign-in window.
 *
 * The window is NetEase's own login page; the user types their own
 * credentials into it. The app reads the cookie the browser ends up
 * holding — it never sees a password.
 */
export async function startNeteaseLogin(): Promise<void> {
  try {
    await invoke("netease_start_login");
  } catch (e) {
    toast.error(String(e));
  }
}

/** Forget the NetEase account. */
export async function logoutNetease(): Promise<void> {
  try {
    await invoke("netease_logout");
  } catch (e) {
    toast.error(String(e));
  }
}

/**
 * Listen for the backend's sign-in and sign-out events.
 *
 * Mount this once, at the app root. The events refresh the session
 * query, which in turn refreshes the daily recommendation — the
 * shelf was rendered as a sign-in prompt a moment ago, and now it
 * shows the picks.
 */
export function useNeteaseAuthListener(): void {
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;

    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ["netease-session"] });
      // The daily recommendation is a function of the account, so it
      // has to be refetched when the account changes.
      void qc.invalidateQueries({ queryKey: ["netease-daily-recommend"] });
    };

    const subscribes: Array<Promise<() => void>> = [
      listen("netease-login-success", refresh),
      listen("netease-login-cancelled", refresh),
      // The backend gives up when the sign-in window stops responding
      // (a crashed WebView2, say). Without this the user would stare at
      // a button that spins forever with no explanation.
      listen("netease-login-failed", (e) => {
        toast.error(String(e.payload));
        refresh();
      }),
    ];

    for (const sub of subscribes) {
      void sub
        .then((un) => {
          if (cancelled) un();
          else dispose = dispose ?? un;
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [qc]);
}

/**
 * The sign-in / sign-out control, with its own pending state.
 *
 * The button stays disabled while the sign-in window is open: the
 * backend closes that window itself once the cookie lands, so the
 * user cannot meaningfully "cancel" from here — and a second click
 * would just re-focus the same window.
 */
export function useNeteaseAuthActions() {
  const [pending, setPending] = useState(false);
  const qc = useQueryClient();

  const signIn = useCallback(async () => {
    setPending(true);
    try {
      await startNeteaseLogin();
    } finally {
      setPending(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setPending(true);
    try {
      await logoutNetease();
      void qc.invalidateQueries({ queryKey: ["netease-session"] });
      void qc.invalidateQueries({ queryKey: ["netease-daily-recommend"] });
      // The cached answers are the account's, so they go with it.
      clearLikeSyncCache();
    } finally {
      setPending(false);
    }
  }, [qc]);

  return { pending, signIn, signOut };
}
