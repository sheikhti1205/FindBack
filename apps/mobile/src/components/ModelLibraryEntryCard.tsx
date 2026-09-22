/**
 * Model Library entry card (Task 26, NEW FILE — presentational only).
 *
 * Shows one catalogue entry with its license, verification badge, RAM triple
 * (minimum / recommended / your-device-now) plus the requirement source chip,
 * and any catalogue warnings. Passive readings only: `availableFreeRamMb` is
 * supplied by the caller, never probed here. Selection is a callback — no
 * downloader or runtime integration.
 */

import {
  catalogueWarnings,
  isInstallable,
  licenseLabel,
  verificationLabel,
} from "../services/models/modelCatalogue";
import {
  describeRamFigures,
  getRamBand,
  ramBandNote,
  ramSourceChip,
} from "../services/models/ramPolicy";
import type {
  AvailableFreeRamMb,
} from "../services/models/ramPolicy";
import type { ModelCatalogueEntry } from "../services/models/catalogueTypes";

export interface ModelLibraryEntryCardProps {
  entry: ModelCatalogueEntry;
  availableFreeRamMb: AvailableFreeRamMb;
  onSelect?: (id: string) => void;
}

export function ModelLibraryEntryCard({
  entry,
  availableFreeRamMb,
  onSelect,
}: ModelLibraryEntryCardProps) {
  const figures = describeRamFigures(entry, availableFreeRamMb);
  const band = getRamBand(entry, availableFreeRamMb);
  const bandNote = ramBandNote(band);
  const warnings = catalogueWarnings(entry);
  const installable = isInstallable(entry);

  return (
    <article
      data-testid="model-library-entry"
      data-entry-id={entry.id}
      aria-label={entry.displayName}
      className="rounded-m3-sm border border-outline-variant bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 break-words text-base font-semibold text-on-surface">
          {entry.displayName}
        </h3>
        <span
          data-testid="model-verification-badge"
          className="rounded-full bg-surface-container px-2 py-0.5 text-xs text-on-surface-variant"
        >
          {verificationLabel(entry.verificationStatus)}
        </span>
      </div>

      <p className="mt-1 text-xs text-on-surface-variant">
        <span data-testid="model-role">{entry.role}</span>
        {" · "}
        <span data-testid="model-license">{licenseLabel(entry.license)}</span>
      </p>

      <p className="mt-2 text-sm text-on-surface">{entry.description}</p>

      <ul className="mt-2 space-y-0.5 text-sm text-on-surface" aria-label="Memory requirements">
        <li data-testid="model-ram-min">{figures.minimumLabel}</li>
        <li data-testid="model-ram-rec">{figures.recommendedLabel}</li>
        <li data-testid="model-ram-now">{figures.deviceNowLabel}</li>
      </ul>

      <p className="mt-2">
        <span
          data-testid="model-ram-source-chip"
          className="rounded-full bg-surface-container px-2 py-0.5 text-xs text-on-surface-variant"
        >
          {ramSourceChip(entry.ramRequirementSource)}
        </span>
      </p>

      {entry.ramNotes ? (
        <p data-testid="model-ram-notes" className="mt-1 text-xs text-on-surface-variant">
          {entry.ramNotes}
        </p>
      ) : null}

      {warnings.map((warning) => (
        <p
          key={warning}
          data-testid="model-warning"
          role="note"
          className="mt-1 text-xs text-on-surface-variant"
        >
          {warning}
        </p>
      ))}

      {bandNote ? (
        <p data-testid="model-ram-band-note" role="status" className="mt-1 text-sm text-on-surface">
          {bandNote}
        </p>
      ) : null}

      {!installable ? (
        <p data-testid="model-not-installable-note" className="mt-2 text-sm text-on-surface-variant">
          Evaluation reference — not installable from the v1 library.
        </p>
      ) : null}

      {onSelect && installable ? (
        <button
          type="button"
          data-testid="model-select-button"
          onClick={() => onSelect(entry.id)}
          className="mt-3 flex min-h-[48px] items-center justify-center rounded-m3-sm bg-primary px-4 text-sm font-medium text-on-primary"
        >
          Select {entry.displayName}
        </button>
      ) : null}
    </article>
  );
}
