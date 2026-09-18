import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { consumeBackIntercept, consumeHistorySuppression, historyDepth } from "./backNavigation";

export interface BackContext {
  /** React Router history has an entry before the current one. */
  canGoBack: boolean;
  pathname: string;
  /** The first back press at the root already happened (within the timeout). */
  armed: boolean;
  /** The user re-tapped Home, so ignore history for this press. */
  suppressHistory: boolean;
}

export type BackAction =
  | { type: "back" }
  | { type: "home" }
  | { type: "arm" }
  | { type: "exit" };

/** Home is the single bottom of the stack; only there does back leave the app. */
export const HOME_PATH = "/";

/**
 * Decides what a back press should do.
 *
 * Order: walk real history, otherwise fall back to Home, otherwise (already on
 * Home) require a second press before exiting so an accidental back cannot
 * quit the app.
 */
export function resolveBackAction(ctx: BackContext): BackAction {
  if (!ctx.suppressHistory && ctx.canGoBack) return { type: "back" };
  if (ctx.pathname !== HOME_PATH) return { type: "home" };
  return ctx.armed ? { type: "exit" } : { type: "arm" };
}

const EXIT_ARM_MS = 2000;

/**
 * Routes the Android hardware/gesture back button through React Router.
 *
 * Capacitor does not handle the back button on its own, so without this the
 * Activity finishes and the whole app closes from any screen.
 */
export function BackButtonHandler() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [toast, setToast] = useState(false);
  const pathRef = useRef(pathname);
  const armedRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  pathRef.current = pathname;

  useEffect(() => {
    armedRef.current = false;
    setToast(false);
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, [pathname]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let cancelled = false;
    let removeListener: (() => void) | undefined;

    void CapacitorApp.addListener("backButton", () => {
      // An open dialog consumes the press before any navigation.
      if (consumeBackIntercept()) return;

      const action = resolveBackAction({
        canGoBack: historyDepth() > 0,
        pathname: pathRef.current,
        armed: armedRef.current,
        suppressHistory: consumeHistorySuppression(pathRef.current),
      });

      switch (action.type) {
        case "back":
          navigate(-1);
          break;
        case "home":
          navigate(HOME_PATH, { replace: true });
          break;
        case "arm":
          armedRef.current = true;
          setToast(true);
          if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => {
            armedRef.current = false;
            setToast(false);
          }, EXIT_ARM_MS);
          break;
        case "exit":
          void CapacitorApp.exitApp();
          break;
      }
    }).then((handle) => {
      if (cancelled) void handle.remove();
      else removeListener = () => void handle.remove();
    });

    return () => {
      cancelled = true;
      removeListener?.();
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, [navigate]);

  if (!toast) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4"
    >
      <span className="rounded-full bg-on-surface px-4 py-2 text-sm text-surface shadow-lg">
        Press back again to exit
      </span>
    </div>
  );
}
