import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { App as NativeApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "../auth";
import {
  parseExternalAuthEntry,
  takePendingExternalAuthEntry,
  type ExternalAuthEntry,
} from "../utils/externalAuthEntry";
import { consumeAuthReturnTo } from "../utils/authReturnTo";
import { exchangeRecoveryCode } from "../services/auth";
import { completeGoogleWebCallback } from "../services/auth/googleSignIn";
import { getPendingReportRoute } from "../utils/pendingReportLink";

/**
 * X3/X4 — external auth entry bridge for the HashRouter app.
 *
 * Handles the two path-based callbacks the provider/email flows return to
 * (`/auth/callback`, `/recovery`) plus the same paths arriving as Android App
 * Links. The credential-bearing query is stripped before this runs (capture in
 * `main.tsx` for the browser; App Link URLs are parsed here). The code is
 * exchanged once and never logged.
 */
export function AuthLinkBootstrap() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const [processing, setProcessing] = useState(false);
  // Persist the one-shot web entry and the "already started" latch across the
  // dev-only StrictMode double-effect so the entry is never consumed twice nor
  // left with a stuck overlay.
  const pendingEntryRef = useRef<ExternalAuthEntry | null | undefined>(undefined);
  const startedRef = useRef(false);

  useEffect(() => {
    let stopped = false;
    let removeListeners: (() => void) | undefined;
    let warmReceived = false;

    const routeFor = (outcome: Awaited<ReturnType<typeof completeGoogleWebCallback>>): void => {
      if (outcome.status === "needsProfile") {
        navigateRef.current("/complete-profile", { replace: true, state: { seed: outcome.seed } });
        return;
      }
      const intended = consumeAuthReturnTo() ?? getPendingReportRoute() ?? "/";
      navigateRef.current(intended, { replace: true });
    };

    const process = async (entry: ExternalAuthEntry): Promise<void> => {
      if (stopped) return;
      setProcessing(true);

      // Recovery is its own flow: a failed/used exchange must land on the
      // recovery invalid-link screen, never the Google error path.
      if (entry.kind === "recovery") {
        try {
          if (!entry.code) {
            navigateRef.current("/recovery", { replace: true, state: { linkError: true } });
            return;
          }
          await exchangeRecoveryCode(entry.code);
          navigateRef.current("/recovery", { replace: true, state: { recovered: true } });
        } catch {
          navigateRef.current("/recovery", { replace: true, state: { linkError: true } });
        } finally {
          setProcessing(false);
        }
        return;
      }

      // auth-callback (web Google OAuth)
      try {
        if (entry.error) {
          navigateRef.current("/auth", { replace: true, state: { googleError: entry.error } });
          return;
        }
        if (!entry.code) {
          navigateRef.current("/auth", { replace: true });
          return;
        }
        const outcome = await completeGoogleWebCallback(entry.code);
        authRef.current.adoptExternalAuthOutcome(outcome);
        routeFor(outcome);
      } catch {
        navigateRef.current("/auth", { replace: true, state: { googleError: "failed" } });
      } finally {
        setProcessing(false);
      }
    };

    const fromNativeUrl = (raw: string): ExternalAuthEntry | null => {
      try {
        const url = new URL(raw);
        return parseExternalAuthEntry({
          pathname: url.pathname,
          search: url.search,
          origin: url.origin,
        });
      } catch {
        return null;
      }
    };

    if (!Capacitor.isNativePlatform()) {
      if (pendingEntryRef.current === undefined) {
        pendingEntryRef.current = takePendingExternalAuthEntry();
      }
      const entry = pendingEntryRef.current;
      if (entry && !startedRef.current) {
        startedRef.current = true;
        void process(entry);
      }
      return () => {
        stopped = true;
      };
    }

    void (async () => {
      try {
        const handle = await NativeApp.addListener("appUrlOpen", ({ url }) => {
          warmReceived = true;
          const entry = fromNativeUrl(url);
          if (entry) void process(entry);
        });
        if (stopped) {
          await handle.remove();
          return;
        }
        removeListeners = () => {
          void handle.remove();
        };
        const launch = await NativeApp.getLaunchUrl();
        if (launch?.url && !warmReceived) {
          const entry = fromNativeUrl(launch.url);
          if (entry) void process(entry);
        }
      } catch {
        /* ordinary launches and unsupported bridges have no URL */
      }
    })();

    return () => {
      stopped = true;
      removeListeners?.();
    };
  }, []);

  if (!processing) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface/95 backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-3">
        <span
          aria-hidden="true"
          className="h-6 w-6 animate-spin rounded-full border-2 border-outline-variant border-t-on-surface"
        />
        <p className="text-sm text-on-surface-variant">Signing you in…</p>
      </div>
    </div>
  );
}
