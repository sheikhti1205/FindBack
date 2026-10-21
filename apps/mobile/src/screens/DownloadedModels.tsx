import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { BottomSheet } from "../components/BottomSheet";
import { Button } from "../components/Button";
import { SettingsGroup, SettingsPage, SettingsRow } from "../components/settings";
import { getApplicationAi } from "../services/ai/applicationAi";
import type { ModelDescriptor } from "../services/ai/modelDescriptors";
import {
  localOperationNotice, localSearchHelperView, useLocalIntelligenceService,
  type LocalAssetAction, type LocalIntelligenceService,
} from "../services/ai/localIntelligenceView";

/** Shared helper row; the two screens read and act on the same lifecycle. */
export function LocalSearchHelperRow({ service, descriptor, phase, onRemove, description = "Understands search phrases and helps with report text and categories.", onBusyChange }: {
  service: LocalIntelligenceService;
  descriptor: ModelDescriptor | undefined;
  phase: "checking" | "ready" | "storage-unverified" | "failed";
  onRemove?: () => void;
  /** Search already explains the offer; settings retain the fuller guidance. */
  description?: ReactNode;
  /**
   * The device is busy with this row's operation.
   *
   * The row knows it is busy from the CLICK, while the transfer itself is
   * registered by the device a tick later. A surface that offers a way out
   * around this row (the Search offer) has to hear about the whole window,
   * or it would offer to dismiss a download the device has already started.
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const titleId = useId();
  const [pending, setPending] = useState<LocalAssetAction | null>(null);
  const operation = useRef(0);
  /** How many operations are in flight at once (overlapping actions count). */
  const busyOperations = useRef(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modelId = descriptor?.modelId;
  const status = modelId ? service.manager.statusOf(modelId) : undefined;
  const view = descriptor ? localSearchHelperView(descriptor, status, service.notice(descriptor.modelId)) : null;
  const supported = service.android && modelId !== undefined && service.compatibility(modelId).compatible;
  const available = phase === "ready" && supported;
  const locked = (pending !== null && pending !== "download") || (modelId !== undefined && service.busy(modelId));
  // An unreadable model store must not strand the user: removal is a
  // canonical, file-level action that still works when the status read
  // failed, so it stays offered in that phase.
  const removable = (view?.removable ?? false) || phase === "storage-unverified";
  // The device verdict belongs on the state line, not on a second line that
  // contradicts it. A verified file stays "Installed" even when this device
  // cannot run it — both facts in one honest line.
  const state = phase === "checking" ? "Checking downloads…"
    : phase === "failed" ? "Couldn't check downloads. Try reopening FindBack."
      : phase === "storage-unverified" ? "Couldn't check the downloaded files on this device."
        : !descriptor ? "Unavailable in this app."
          : !service.android ? "Downloads need the Android app."
            : !supported
              ? view?.installed
                ? "Installed · unavailable on this device"
                : "Unavailable on this device."
              : view?.state ?? "Unavailable in this app.";

  function run(action: LocalAssetAction) {
    if (!modelId || locked) return;
    const id = ++operation.current;
    setPending(action); setError(null); setFeedback(null);
    // The device is busy with this row's operation from the click onward, so
    // the surface around it hears about the whole window. Overlapping
    // operations are counted, not toggled: the row stays busy until the LAST
    // one settles.
    busyOperations.current += 1;
    onBusyChange?.(true);
    void service[action](modelId).then(() => {
      if (action === "verify" && service.manager.statusOf(modelId)?.checksumVerified) setFeedback("Downloaded file checked.");
    }).catch((reason: unknown) => {
      setError(localOperationNotice(reason instanceof Error ? reason.message : "unknown"));
    }).finally(() => {
      if (operation.current === id) setPending(null);
      busyOperations.current = Math.max(0, busyOperations.current - 1);
      onBusyChange?.(busyOperations.current > 0);
    });
  }

  return <article aria-labelledby={titleId} className="flex min-w-0 flex-col gap-2 px-1 py-3">
    <div className="min-w-0">
      <h3 id={titleId} className="text-sm font-medium">Local search helper</h3>
      {description && <p className="text-sm text-on-surface-variant">{description}</p>}
    </div>
    <p role="status" className="text-sm text-on-surface-variant">{state}</p>
    {view && <>
      {!view.sizeInAction && <p className="text-xs text-on-surface-variant">{view.downloadSize} download</p>}
      {view.transferDetail && <p className="text-xs text-on-surface-variant">{view.transferDetail}</p>}
      {status?.download === "downloading" && <progress className="w-full accent-primary" aria-label="Local search helper download progress" max={100} value={view.progress ?? undefined} />}
      {available && view.notice && <p className="text-sm text-on-surface-variant">{view.notice}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {available && descriptor?.downloadable && view.primary && <Button variant="outline" disabled={locked} onClick={() => run(view.primary!.action)}>{view.primary.label}</Button>}
        {service.android && removable && onRemove && <Button variant="text" disabled={locked} aria-label="Remove local search helper" onClick={onRemove}>Remove</Button>}
      </div>
      {available && view.installed && onRemove && <details>
        <summary className="min-h-12 cursor-pointer py-3 text-sm">File options</summary>
        <Button variant="text" disabled={locked || pending !== null} onClick={() => run("verify")}>Check downloaded file</Button>
      </details>}
    </>}
    {feedback && <p role="status" className="text-sm text-on-surface-variant">{feedback}</p>}
    {error && <p role="alert" className="text-sm text-error">{error}</p>}
  </article>;
}

/** Runs after the shared sheet's exit, when the removed trigger no longer exists. */
function RemovalFocusReturn({ completed, target }: { completed: RefObject<boolean>; target: RefObject<HTMLParagraphElement | null> }) {
  useEffect(() => () => { if (completed.current) target.current?.focus(); }, [completed, target]);
  return null;
}

/** Device-owned storage; no account store or alternate downloader. */
export function DownloadedModels({ service = getApplicationAi(), backTo = "/settings/local-intelligence" }: {
  service?: LocalIntelligenceService;
  backTo?: string;
}) {
  const { helper, phase } = useLocalIntelligenceService(service);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removingRef = useRef(false);
  const removalSucceeded = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);

  function remove() {
    if (!helper || removingRef.current) return;
    removingRef.current = true; setRemoving(true); setError(null);
    void service.remove(helper.modelId).then(() => {
      removalSucceeded.current = true;
      setConfirmRemove(false); setFeedback("Local search helper removed. Normal search is still available.");
    }).catch((reason: unknown) => {
      setError(localOperationNotice(reason instanceof Error ? reason.message : "unknown"));
    }).finally(() => { removingRef.current = false; setRemoving(false); });
  }

  return <>
    <div inert={confirmRemove || undefined}>
      <SettingsPage title="Downloaded models" description="Manage the local tools stored on this device." backTo={backTo} backLabel="Back to Local intelligence">
        <div className="px-1 text-sm text-on-surface-variant">
          <p>Total storage use unavailable</p>
          <p className="mt-1">This screen lists the local search helper. Other on-device models are managed under AI &amp; models.</p>
        </div>
        <SettingsGroup title="Smart Search">
          <LocalSearchHelperRow service={service} descriptor={helper} phase={phase} onRemove={() => { removalSucceeded.current = false; setError(null); setFeedback(null); setConfirmRemove(true); }} />
        </SettingsGroup>
        <SettingsGroup title="Matching" description="Possible Matches suggests reports using text, category, date and location — not photos.">
          <p className="px-1 text-sm text-on-surface-variant">Photo matching isn't available in this app yet, so there's no matching download to manage.</p>
        </SettingsGroup>
        <SettingsGroup title="Built-in">
          <SettingsRow title="Semantic text matching" description={service.android ? "Included with FindBack · Not removable separately" : "Included with the Android app · Unavailable here"} />
        </SettingsGroup>
        <p className="px-1 text-sm text-on-surface-variant">Downloaded tools stay on this device when you sign out.</p>
        {feedback && <p ref={feedbackRef} tabIndex={-1} role="status" className="text-sm text-on-surface-variant">{feedback}</p>}
      </SettingsPage>
    </div>
    <BottomSheet open={confirmRemove} title="Remove local search helper?" description="Normal search will still work. Smart Search and report text assistance, including category suggestions, will need another download." height="medium" dismissible={!removing} onClose={() => { if (!removingRef.current) setConfirmRemove(false); }}>
      <RemovalFocusReturn completed={removalSucceeded} target={feedbackRef} />
      <p className="text-sm text-on-surface-variant">This removes the helper's downloaded files and any unfinished download.</p>
      {error && <p role="alert" className="mt-2 text-sm text-error">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" disabled={removing} onClick={() => setConfirmRemove(false)}>Keep helper</Button>
        <Button variant="error" loading={removing} onClick={remove}>Remove helper</Button>
      </div>
    </BottomSheet>
  </>;
}
