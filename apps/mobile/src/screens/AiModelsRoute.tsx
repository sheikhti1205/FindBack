import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Gauge } from "lucide-react";
import { Button } from "../components/Button";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  StatusPill,
} from "../components/settings";
import {
  DEVICE_INCOMPATIBLE_REASON,
  getApplicationAi,
  type ApplicationAiService,
} from "../services/ai/applicationAi";
import { tierOf, type ModelDescriptor } from "../services/ai/modelDescriptors";
import { qualifiedUiRolesForOfflineModel } from "../services/ai/uiModelRoles";
import { canShowAuto } from "../services/ai/uiGates";
import { AdvancedModelSupply } from "./AiModelsRouteAdvanced";

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Consumer role summary: what the user can do with this model, in plain
 * words. Derived from the descriptor's qualified UI roles — never ids,
 * hashes, or runtime terms. Unmeasured Advanced rows (no qualified roles
 * yet) name the modality only, never invented capabilities.
 */
const ROLE_SUMMARY: Readonly<Record<string, string>> = {
  chat: "Answers questions",
  vision: "Describes photos",
  tools: "Fills in reports",
  embeddings: "Finds similar items",
};

function roleSummaryFor(descriptor: ModelDescriptor): string | null {
  const roles = qualifiedUiRolesForOfflineModel(descriptor.modelId).filter((role) => role in ROLE_SUMMARY);
  if (roles.length > 0) return roles.map((role) => ROLE_SUMMARY[role] as string).join(" · ");
  if (descriptor.capabilities.includes("vision")) return "Photo model";
  if (descriptor.capabilities.includes("text")) return "Text model";
  return null;
}

function isStorageShortfall(reason: string | null): boolean {
  return reason !== null && /storage|free space|free_bytes|out of space/i.test(reason);
}

/**
 * Translate service-owned outcome copy at the presentation seam so the
 * normal tier never shows engineering wording (raw model ids, checksum /
 * catalogue terms, transfer jargon). Unknown strings pass through verbatim
 * (never invented here) — every reason the download/manager layer can emit
 * today is mapped below.
 */
export function toConsumerNotice(notice: string | null): string | null {
  if (notice === null) return null;
  if (notice === "Installed and checksum verified.") return null;
  if (notice === "checksum mismatch against catalogue pin") {
    return "The download didn't pass verification. Try again.";
  }
  if (notice === "no catalogue checksum pin for this model") {
    return "The download couldn't be verified. Try again.";
  }
  if (notice === "checksum verification failed") {
    return "The download didn't pass verification. Try again.";
  }
  if (notice === "transfer failed") {
    return "The download was interrupted. Try again.";
  }
  if (notice === "not enough free storage for this download") {
    return "Needs more storage";
  }
  if (notice === "downloads start only on explicit user action") {
    return "Tap Download to start.";
  }
  if (notice === "model installed") {
    return "Already installed.";
  }
  if (notice.startsWith("unknown model ")) {
    return "This tool isn't available in this build.";
  }
  return notice.replaceAll("AI & Models", "On-device AI");
}

function ConsumerCard({
  descriptor,
  service,
  reportError,
  advanced = false,
}: {
  descriptor: ModelDescriptor;
  service: ApplicationAiService;
  reportError: (message: string) => void;
  /** Advanced rows: truthful state, never a download/dead action. */
  advanced?: boolean;
}) {
  const modelId = descriptor.modelId;
  const title = descriptor.consumerTitle;
  const detail = descriptor.consumerDetail;
  const tier = tierOf(descriptor);
  const roleSummary = roleSummaryFor(descriptor);
  const totalBytes = descriptor.bytes > 0 ? descriptor.bytes : null;
  const status = service.manager.statusOf(modelId);
  const download = status?.download ?? "not-installed";
  const downloadedBytes = status?.downloadedBytes ?? 0;
  const lastError = status?.lastError ?? null;
  const rawNotice = service.notice(modelId);
  const notice = toConsumerNotice(rawNotice ?? lastError);
  const busy = service.busy(modelId);
  const ready = download === "installed" && status?.checksumVerified === true;
  const percent =
    totalBytes !== null && totalBytes > 0
      ? Math.min(100, Math.max(0, Math.round((downloadedBytes / totalBytes) * 100)))
      : null;

  const run = (work: Promise<unknown>) => {
    void work.catch((error: unknown) =>
      reportError(error instanceof Error ? error.message : "On-device operation failed."),
    );
  };

  // Compatibility is presentation only: the service enforces it again at
  // download/run time. An incompatible device names the state instead of
  // offering a dead download.
  const compatibility = service.compatibility(modelId);
  const supported = service.android && compatibility.compatible;
  const supportTitle = !service.android
    ? "On-device downloads need the Android app."
    : compatibility.compatible
      ? undefined
      : DEVICE_INCOMPATIBLE_REASON;
  // Not-offered rows keep a SHORT pill state and carry the full legal /
  // verification reason as wrapping body copy. Putting the whole sentence in
  // the pill forced a wide, unshrinkable row that overflowed phone widths.
  const notOffered = advanced || !descriptor.downloadable;
  const reasonNote = notOffered
    ? ((descriptor.distributionNote ?? "").trim() !== ""
      ? (descriptor.distributionNote as string)
      : "Not offered as a download.")
    : null;
  const stateLine = notOffered
    ? "Not offered"
    : !compatibility.compatible && service.android
      ? DEVICE_INCOMPATIBLE_REASON
      : ready
        ? `Ready · ${totalBytes !== null ? formatMegabytes(totalBytes) : formatMegabytes(downloadedBytes)}`
        : download === "downloading" && percent !== null
          ? `Downloading ${percent}%`
          : download === "paused" && percent !== null && downloadedBytes > 0
            ? `Paused at ${percent}%`
            : download === "failed" && isStorageShortfall(lastError ?? notice)
              ? "Needs more storage"
              : download === "verifying" || download === "queued"
                ? "Getting ready…"
                : "Not installed";
  // The status pill and the reason copy already carry the state; never repeat
  // either as a notice (e.g. a storage shortfall reads "Needs more storage"
  // once).
  const showNotice = notice !== null && !ready && !notOffered && notice !== stateLine;
  const showActions = !advanced && descriptor.downloadable;

  return (
    <article aria-labelledby={`ai-tool-${modelId}`} className="flex flex-col gap-2 p-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h3 id={`ai-tool-${modelId}`} className="text-sm font-semibold">
            {title}
          </h3>
          <p className="text-xs text-on-surface-variant">{detail}</p>
          {roleSummary !== null ? (
            <p className="text-xs text-on-surface-variant">{roleSummary}</p>
          ) : null}
          {totalBytes === null ? (
            <p className="text-xs text-on-surface-variant">Size unavailable</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            data-testid={`ai-tier-${modelId}`}
            className="rounded-m3-xs border border-outline-variant px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-on-surface-variant"
          >
            {tier === "recommended" ? "Recommended" : "Advanced"}
          </span>
          <StatusPill tone={ready ? "success" : download === "failed" ? "error" : "neutral"}>
            {stateLine}
          </StatusPill>
        </div>
      </div>
      {download === "downloading" && percent !== null ? (
        <div
          role="progressbar"
          aria-label={`${title} download progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 overflow-hidden rounded-full bg-surface-container-high"
        >
          <div
            aria-hidden="true"
            className="h-full rounded-full bg-control-active"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
      {reasonNote !== null ? (
        <p data-testid={`ai-reason-${modelId}`} className="text-xs text-on-surface-variant">
          {reasonNote}
        </p>
      ) : null}
      {showNotice ? (
        <p role="status" className="text-sm text-on-surface-variant">
          {notice}
        </p>
      ) : null}
      {showActions ? (
      <div className="flex flex-wrap gap-2">
        {ready ? (
          <>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => run(service.verify(modelId))}
            aria-label={`Verify ${title}`}
          >
            Verify
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => run(service.remove(modelId))}
            aria-label={`Remove ${title}`}
          >
            Remove
          </Button>
          </>
        ) : download === "downloading" ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => run(service.pause(modelId))}
            aria-label={`Pause ${title}`}
          >
            Pause
          </Button>
        ) : download === "paused" ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={!supported || busy}
              onClick={() => run(service.download(modelId))}
              aria-label={`Resume ${title}`}
              title={supportTitle}
            >
              Resume
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => run(service.remove(modelId))}
              aria-label={`Remove ${title}`}
            >
              Remove
            </Button>
          </>
        ) : download === "verifying" || download === "queued" ? null : (
          <Button
            type="button"
            variant="outline"
            disabled={!supported || busy}
            onClick={() => run(service.download(modelId))}
            aria-label={`Download ${title}`}
            title={supportTitle}
          >
            Download
          </Button>
        )}
        {!ready && download !== "downloading" && download !== "paused" && download !== "verifying" && download !== "queued" && download !== "not-installed" ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => run(service.remove(modelId))}
            aria-label={`Remove ${title}`}
          >
            Remove
          </Button>
        ) : null}
      </div>
      ) : null}
    </article>
  );
}

/** Real route owns UI subscriptions; application service owns all transfers and residency. */
export function AiModelsRoute({ service = getApplicationAi() }: { service?: ApplicationAiService }) {
  useSyncExternalStore(service.subscribe, service.snapshot);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedId = useId();
  const measured = canShowAuto(service.probeRecords, service.probeContext);
  // Refresh per-model device compatibility once per service: the snapshot
  // subscription re-renders when the service publishes the results.
  useEffect(() => {
    void service.ensureCompatibility().catch(() => {});
  }, [service]);

  return (
    <SettingsPage
      title="On-device AI"
      description="Tools that run on this phone. No connection needed once downloaded."
      backTo="/settings/ai"
      backLabel="Back to AI & intelligence"
    >
      {!service.android ? (
        <p role="note" className="text-sm text-on-surface-variant">
          On-device AI needs the Android app. Downloads below are unavailable here.
        </p>
      ) : null}
      <SettingsGroup title="Tools">
        {service.registry.catalogue().map((descriptor) => (
          <ConsumerCard
            key={descriptor.modelId}
            descriptor={descriptor}
            service={service}
            reportError={setError}
          />
        ))}
      </SettingsGroup>
        <SettingsGroup
          title="Advanced"
          description="Import models or try an explicit evaluation. These tests do not change your tools."
        >
          <Button type="button" variant="outline" aria-expanded={advancedOpen} aria-controls={advancedId} onClick={() => setAdvancedOpen((value) => !value)}>{advancedOpen ? "Close Advanced" : "Open Advanced"}</Button>
          {advancedOpen ? <div id={advancedId} className="mt-4 min-w-0"><AdvancedModelSupply service={service} /></div> : null}
        </SettingsGroup>
      {error !== null ? (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      ) : null}
      <SettingsGroup
        title="Performance"
        description={
          measured
            ? "Performance has been measured on this phone."
            : "FindBack uses the safest available option until performance has been measured on this phone."
        }
      >
        <SettingsRow
          title="Measure performance"
          description="Run speed tests and see technical details."
          icon={Gauge}
          iconTone="ai"
          route="/settings/ai/advanced"
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
