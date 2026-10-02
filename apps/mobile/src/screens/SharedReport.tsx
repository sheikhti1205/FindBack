import { useEffect, useRef } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { useAuth } from "../auth";
import { parseReportLink, reportLink } from "../utils/reportLinks";
import { Splash } from "./Splash";
import { rememberReportLink } from "../utils/pendingReportLink";

/** No anonymous report fetch, title, image, author or description. */
export function SharedReport() {
  const {id = ""} = useParams();
  const {search} = useLocation();
  const {user, booting, bootError} = useAuth();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  let url = "";
  try { url = `${reportLink(id)}${search}`; } catch { /* invalid config */ }
  const link = parseReportLink(url);
  useEffect(() => { if (!user && parseReportLink(url)) rememberReportLink(url); }, [url, user]);
  if (!link) return <main className="mx-auto max-w-lg p-6"><h1 className="text-2xl font-semibold">Invalid report link</h1><Link className="mt-4 inline-flex min-h-12 items-center underline" to="/">Back to FindBack</Link></main>;
  if (booting || (bootError && !user)) return <Splash />;
  if (user) return <Navigate to={link.route} replace />;
  return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 bg-surface px-6 py-12 text-on-surface">
    <p className="text-lg font-semibold">FindBack</p>
    <h1 ref={title} tabIndex={-1} className="text-3xl font-semibold tracking-tight">A FindBack report was shared with you.</h1>
    <p className="leading-relaxed text-on-surface-variant">Sign in to view the report, its photos and comments. Report content is only available to FindBack members.</p>
    <Link to="/signin" className="inline-flex min-h-12 items-center justify-center rounded-m3-md bg-on-surface px-5 font-medium text-surface focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-on-surface">Sign in to view</Link>
    <a href={url} className="inline-flex min-h-12 items-center justify-center rounded-m3-md border border-outline px-5 font-medium focus-visible:outline-2 focus-visible:outline-offset-4">Open FindBack app</a>
    <p className="text-sm text-on-surface-variant">If FindBack is not installed, you can view this report here after signing in.</p>
  </main>;
}
