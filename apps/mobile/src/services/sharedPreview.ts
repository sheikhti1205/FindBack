import { CATEGORIES } from "@norfold/shared";
import { sharePreviewLink } from "../utils/reportLinks";

export interface PublicReportPreview {
  id: string;
  type: "LOST" | "FOUND";
  title: string;
  category: string;
  event_month: string | null;
  excerpt: string;
}

/** Same-domain renderer and SPA use the same server-authoritative projection. */
export async function getSharedPreview(id: string, signal?: AbortSignal): Promise<PublicReportPreview | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 8000);
  try {
    const res = await fetch(`${sharePreviewLink(id)}?format=json`, {
      method: "GET", credentials: "omit", cache: "no-store", signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("Preview unavailable");
    const text = await res.text();
    if (text.length > 8192) throw new Error("Unexpected preview");
    const p = JSON.parse(text) as PublicReportPreview;
    if (!p || Object.keys(p).sort().join(",") !== "category,event_month,excerpt,id,title,type"
      || p.id !== id || !["LOST", "FOUND"].includes(p.type)
      || !(CATEGORIES as readonly string[]).includes(p.category)
      || typeof p.title !== "string" || !p.title || p.title.length > 80
      || (p.event_month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(p.event_month))
      || p.excerpt !== `A ${p.type.toLowerCase()} item report. Sign in to compare the details and contact the person who posted it.`) throw new Error("Unexpected preview");
    return p;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function publicMonthLabel(month: string | null): string | null {
  return month ? new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T00:00:00Z`)) : null;
}
