import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { clearLikeSyncCache, setNeteaseLikeSyncAvailable } from "@/lib/providers/netease-like";
import { clearAvailability } from "@/lib/providers/availability";
import { clearMatchCache } from "@/lib/providers/match/cache";
import { clearProbeCache } from "@/lib/providers/probe";
import { translate } from "@/lib/i18n";

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
 * The QR code the backend drew for the sign-in.
 *
 * `image` is a `data:` URL of a PNG rendered on this machine — the
 * picture never leaves the app; only the key it encodes did.
 */
export type NeteaseQrCode = {
  image: string;
  key: string;
};

/**
 * Start the NetEase sign-in.
 *
 * The backend asks the platform for a one-time key, renders it as a QR
 * code locally and polls for the scan state. The code comes straight
 * back from the call, so the dialog can show it without waiting for an
 * event to arrive.
 */
export async function startNeteaseLogin(): Promise<NeteaseQrCode | null> {
  try {
    return await invoke<NeteaseQrCode>("netease_start_login");
  } catch (e) {
    toast.error(String(e));
    return null;
  }
}

/** Give up on a sign-in that is in progress. */
export async function cancelNeteaseLogin(): Promise<void> {
  try {
    await invoke("netease_cancel_login");
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
 * Why a sign-in attempt failed, as the backend reports it.
 *
 * The backend sends a code rather than a sentence, so the sentence
 * can be in the user's own language. `detail` carries the technical
 * detail (a network error, say) when there is one worth showing.
 */
export type NeteaseLoginFailure = {
  code:
    | "expired"
    | "blocked"
    | "noCredential"
    | "client"
    | "storage"
    | "unknown";
  detail?: string | null;
};

/**
 * Turn a failure into a sentence.
 *
 * The code decides the sentence; the detail is appended when there is
 * one, so a network error shows what actually went wrong instead of
 * being swallowed by a generic message.
 */
function neteaseFailureMessage(payload: unknown): string {
  const failure = payload as NeteaseLoginFailure | undefined;
  const code = failure?.code ?? "unknown";

  const key = {
    expired: "settings.integrations.neteaseQrExpired",
    blocked: "settings.integrations.neteaseQrBlocked",
    noCredential: "settings.integrations.neteaseQrNoCredential",
    client: "settings.integrations.neteaseQrClientFailed",
    storage: "settings.integrations.neteaseQrStorageFailed",
    unknown: "settings.integrations.neteaseQrFailed",
  }[code];

  const message = translate(key) || key;
  const detail = failure?.detail;
  return detail ? `${message} (${detail})` : message;
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
      // The backend fills in the account's name and avatar after the
      // sign-in window has already closed, so the session has to be
      // re-read once those land.
      listen("netease-profile-ready", refresh),
      // The backend gives up when the sign-in window stops responding
      // (a crashed WebView2, say). Without this the user would stare at
      // a button that spins forever with no explanation.
      listen("netease-login-failed", (e) => {
        toast.error(neteaseFailureMessage(e.payload));
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
 * The sign-out control, with its own pending state.
 *
 * The sign-in lives in its own dialog (see `NeteaseLoginDialog`), which
 * closes itself once the credential lands — so there is nothing for
 * this hook to do about signing in.
 */
export function useNeteaseAuthActions() {
  const [pending, setPending] = useState(false);
  const qc = useQueryClient();

  const signOut = useCallback(async () => {
    setPending(true);
    try {
      await logoutNetease();
      void qc.invalidateQueries({ queryKey: ["netease-session"] });
      void qc.invalidateQueries({ queryKey: ["netease-daily-recommend"] });
      // The cached answers are the account's, so they go with it: which
      // tracks NetEase will serve depends on the membership that just
      // went away.
      clearLikeSyncCache();
      clearAvailability();
      clearProbeCache();
      // The cached searches are the account's too — NetEase's catalogue
      // and its ranking differ for a signed-in member.
      clearMatchCache();
    } finally {
      setPending(false);
    }
  }, [qc]);

  return { pending, signOut };
}
