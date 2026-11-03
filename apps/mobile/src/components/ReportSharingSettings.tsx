import { useEffect, useRef, useState } from "react";
import { getSupabase } from "../services/supabaseClient";

/** Only rendered in owner management; authority is independently checked by SQL. */
export function ReportSharingSettings({ postId, disabled = false }: { postId: string; disabled?: boolean }) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ id: string; enabled: boolean | null; busy: boolean; error: boolean }>({ id: postId, enabled: null, busy: true, error: false });
  const epoch = useRef(0);
  const identity = useRef(postId);
  if (identity.current !== postId) { identity.current = postId; epoch.current++; }
  useEffect(() => {
    const started = ++epoch.current;
    setState({ id: postId, enabled: null, busy: true, error: false });
    void (async () => {
      try {
        const { data, error } = await getSupabase().rpc("findback_report_sharing", { p_post_id: postId, p_enabled: null });
        if (epoch.current !== started) return;
        setState({ id: postId, enabled: !error && typeof data === "boolean" ? data : null, busy: false, error: !!error || typeof data !== "boolean" });
      } catch {
        if (epoch.current === started) setState({ id: postId, enabled: null, busy: false, error: true });
      }
    })();
    return () => { epoch.current++; };
  }, [postId, retry]);
  const current = state.id === postId ? state : { id: postId, enabled: null, busy: true, error: false };
  async function change(enabled: boolean) {
    if (current.busy || disabled || current.enabled === null) return;
    const started = epoch.current;
    setState(s => ({ ...s, busy: true, error: false }));
    try {
      const { data, error } = await getSupabase().rpc("findback_report_sharing", { p_post_id: postId, p_enabled: enabled });
      if (epoch.current !== started) return;
      if (error || typeof data !== "boolean") throw new Error("Sharing unavailable");
      setState({ id: postId, enabled: data, busy: false, error: false });
    } catch {
      if (epoch.current === started) setState(s => ({ ...s, busy: false, error: true }));
    }
  }
  return <div className="mt-3 border-t border-outline-variant pt-3">
    <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
      <input type="checkbox" checked={current.enabled === true} disabled={disabled || current.busy || current.enabled === null}
        onChange={event => { void change(event.target.checked); }} className="h-4 w-4 shrink-0 accent-primary" />
      Public link preview
    </label>
    <p className="text-xs leading-relaxed text-on-surface-variant">Show a short item summary to people without an account. Full details stay in Norfold.</p>
    <p role="status" className="mt-1 text-xs leading-relaxed text-on-surface-variant">{current.busy ? "Updating preview…" : current.enabled === null ? "Preview setting is unavailable." : current.enabled ? "Public preview is on." : "Public preview is off. Signed-in members can still view the report. Previously cached previews may remain."}</p>
    {current.error && <div role="alert" className="mt-2 text-sm text-error">Couldn't update the preview setting. <button type="button" onClick={() => setRetry(v => v + 1)} className="min-h-11 px-2 underline">Try again</button></div>}
  </div>;
}
