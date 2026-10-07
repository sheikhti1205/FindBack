import { useEffect, useState, useSyncExternalStore } from "react";
import { Gauge } from "lucide-react";
import { Button } from "../components/Button";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  StatusPill,
} from "../components/settings";
import {
  DOWNLOAD_MODELS,
  DEVICE_INCOMPATIBLE_REASON,
  getApplicationAi,
  type ApplicationAiService,
} from "../services/ai/applicationAi";
import type { ModelDescriptor } from "../services/ai/modelDescriptors";
import { canShowAuto } from "../services/ai/uiGates";

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
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
}: {
  descriptor: ModelDescriptor;
  service: ApplicationAiService;
  reportError: (message: string) => void;
}) {
  const modelId = descriptor.modelId;
  const title = descriptor.consumerTitle;
  const detail = descriptor.consumerDetail;
  const entry = DOWNLOAD_MODELS.find((item) => item.modelId === modelId);
  const status = service.manager.statusOf(modelId);
  const totalBytes = entry?.bytes ?? null;
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
  const stateLine = !compatibility.compatible && service.android
    ? DEVICE_INCOMPATIBLE_REASON
    : ready
    ? `Ready · ${formatMegabytes(entry?.bytes ?? downloadedBytes)}`
    : download === "downloading" && percent !== null
      ? `Downloading ${percent}%`
      : download === "paused" && percent !== null && downloadedBytes > 0
        ? `Paused at ${percent}%`
        : download === "failed" && isStorageShortfall(lastError ?? notice)
          ? "Needs more storage"
          : download === "verifying" || download === "queued"
            ? "Getting ready…"
            : "Not installed";
  // The status pill already carries the state line; never repeat it as a
  // notice (e.g. a storage shortfall reads "Needs more storage" once).
  const showNotice = notice !== null && !ready && notice !== stateLine;

  return (
    <article aria-labelledby={`ai-tool-${modelId}`} className="flex flex-col gap-2 p-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h3 id={`ai-tool-${modelId}`} className="text-sm font-semibold">
            {title}
          </h3>
          <p className="text-xs text-on-surface-variant">{detail}</p>
        </div>
        <StatusPill tone={ready ? "success" : download === "failed" ? "error" : "neutral"}>
          {stateLine}
        </StatusPill>
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
      {showNotice ? (
        <p role="status" className="text-sm text-on-surface-variant">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {ready ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => run(service.remove(modelId))}
            aria-label={`Remove ${title}`}
          >
            Remove
          </Button>
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
    </article>
  );
}

/** Real route owns UI subscriptions; application service owns all transfers and residency. */
export function AiModelsRoute({ service = getApplicationAi() }: { service?: ApplicationAiService }) {
  useSyncExternalStore(service.subscribe, service.snapshot);
  const [error, setError] = useState<string | null>(null);
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
