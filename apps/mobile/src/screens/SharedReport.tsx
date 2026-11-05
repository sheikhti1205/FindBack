import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { useAuth } from "../auth";
import { parseReportLink, reportLink } from "../utils/reportLinks";
import { Splash } from "./Splash";
import { rememberReportLink } from "../utils/pendingReportLink";
import { getSharedPreview, publicMonthLabel, type PublicReportPreview } from "../services/sharedPreview";

/** No authenticated report projection is fetched for an anonymous visitor. */
export function SharedReport() {
  const {id = ""} = useParams();
  const {search} = useLocation();
  const {user, booting, bootError} = useAuth();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{id:string; status:"loading"|"ready"|"unavailable"|"error"; preview?:PublicReportPreview}>({id,status:"loading"});
  const params = new URLSearchParams(search);
  const contact = params.get("contact") === "1" && params.getAll("contact").length === 1;
  if (contact) params.delete("contact");
  const safeSearch = params.size ? `?${params}` : "";
  let url = "";
  try { url = `${reportLink(id)}${safeSearch}`; } catch { /* invalid config */ }
  const link = parseReportLink(url);
  useEffect(() => { if (!user && parseReportLink(url)) rememberReportLink(url); }, [url, user]);
  const valid = !!link;
  useEffect(() => {
    if (!valid || user || booting || bootError || contact) return;
    let live = true;
    const controller = new AbortController();
    setState({ id, status: "loading" });
    void getSharedPreview(id, controller.signal).then(preview => {
      if (live) setState(preview ? { id, status: "ready", preview } : { id, status: "unavailable" });
    }, () => { if (live) setState({ id, status: "error" }); });
    return () => { live = false; controller.abort(); };
  }, [id, valid, user, booting, bootError, contact, attempt]);
  if (!link) return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-4 bg-surface px-6 py-12 text-on-surface"><p className="text-lg font-semibold">Norfold</p><h1 ref={title} tabIndex={-1} className="text-3xl font-semibold tracking-tight">Invalid report link</h1><p className="leading-relaxed text-on-surface-variant">Check the link and try again, or head back to Norfold.</p><Link className="inline-flex min-h-12 items-center justify-center rounded-m3-md bg-on-surface px-5 font-medium text-surface focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-on-surface" to="/" state={{ showPublic: true }}>Back to Norfold</Link></main>;
  if (booting || (bootError && !user)) return <Splash />;
  if (user) return <Navigate to={link.route} replace />;
  if (contact) return <Navigate to="/signin" replace />;
  const current = state.id === id ? state : { id, status: "loading" as const };
  const preview = current.preview;
  return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 bg-surface px-[min(1.5rem,5vw)] py-12 text-on-surface">
    <p className="text-lg font-semibold">Norfold</p>
    <article aria-label="Shared report preview" className="min-w-0 break-words" aria-live="polite" aria-busy={current.status === "loading"}>
      {preview && <span className="inline-block rounded-full px-3 py-1 text-xs font-semibold" style={{background:`var(--fb-${preview.type.toLowerCase()}-bg)`,color:`var(--fb-${preview.type.toLowerCase()}-ink)`}}>{preview.type === "LOST" ? "Lost" : "Found"}</span>}
      <h1 ref={title} tabIndex={-1} className="mt-4 text-3xl font-semibold tracking-tight">{preview?.title ?? (current.status === "unavailable" ? "This report is no longer available" : current.status === "error" ? "Couldn't load this report" : "Shared report")}</h1>
      {current.status === "loading" && <p role="status" className="mt-4 text-on-surface-variant">Loading report preview…</p>}
      {preview && <>
        <p className="mt-3 text-sm text-on-surface-variant">{preview.category}{preview.event_month && ` · ${publicMonthLabel(preview.event_month)}`}</p>
        <p className="mt-4 leading-relaxed text-on-surface-variant">{preview.excerpt}</p>
      </>}
      {current.status === "unavailable" && <p className="mt-4 text-on-surface-variant">The link may have been withdrawn, or the report is no longer shared.</p>}
      {current.status === "error" && <div role="alert"><p className="mt-4 text-on-surface-variant">Check your connection and try again.</p><button type="button" onClick={() => setAttempt(v => v + 1)} className="mt-2 min-h-11 underline">Try again</button></div>}
    </article>
    {preview && <><Link to="/signin" className="inline-flex min-h-12 items-center justify-center rounded-m3-md bg-primary px-5 font-medium text-on-primary focus-visible:outline-2 focus-visible:outline-offset-4">Sign in to contact</Link>
      <a href={url} className="inline-flex min-h-12 items-center justify-center rounded-m3-md border border-outline px-5 font-medium focus-visible:outline-2 focus-visible:outline-offset-4">Open in Norfold</a>
      <p className="text-sm text-on-surface-variant">Sign in for the full description, photos and contact options.</p></>}
    {current.status !== "ready" && current.status !== "loading" && <Link to="/" state={{ showPublic: true }} className="min-h-11 underline">Back to Norfold</Link>}
  </main>;
}
