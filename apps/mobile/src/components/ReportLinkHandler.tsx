import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { App as NativeApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "../auth";
import { parseReportLink, publicShareOrigin } from "../utils/reportLinks";
import { clearPendingReportLink, getPendingReportRoute, rememberReportLink } from "../utils/pendingReportLink";

/** Never feeds arbitrary external input into the router. */
export function ReportLinkHandler() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const location = useLocation();
  const { user, booting } = useAuth();
  const authRef = useRef({user, booting});
  authRef.current = {user, booting};

  useEffect(() => {
    let stopped = false;
    let remove: (() => void) | undefined;
    let warmReceived = false;
    const open = (url: string) => {
      if (stopped) return;
      const link = parseReportLink(url);
      if (!link) return;
      rememberReportLink(url);
      const authenticated = authRef.current.user && !authRef.current.booting;
      navigateRef.current(authenticated ? link.route : link.sharedRoute, { replace: true });
    };
    if (!Capacitor.isNativePlatform()) {
      // The public server returns the app shell at /r/:id; hash navigation
      // thereafter preserves the current app's routing and authorization.
      if (!window.location.hash && window.location.pathname.startsWith("/r/")) {
        try { open(`${publicShareOrigin()}${window.location.pathname}${window.location.search}`); } catch { /* unconfigured dev server */ }
      }
      return;
    }
    void (async () => {
      try {
        const handle = await NativeApp.addListener("appUrlOpen", ({url}) => { warmReceived = true; open(url); });
        if (stopped) { await handle.remove(); return; }
        remove = () => { void handle.remove(); };
        const launch = await NativeApp.getLaunchUrl();
        if (launch?.url && !warmReceived) open(launch.url);
      } catch { /* ordinary launches and unsupported bridges have no URL */ }
    })();
    return () => { stopped = true; remove?.(); };
  }, []);

  useEffect(() => {
    if (!user || booting) return;
    const route = getPendingReportRoute();
    if (!route) return;
    if (`${location.pathname}${location.search}${location.hash}` === route) clearPendingReportLink();
    else navigate(route, {replace:true});
  }, [user, booting, navigate, location.pathname, location.search, location.hash]);
  return null;
}
