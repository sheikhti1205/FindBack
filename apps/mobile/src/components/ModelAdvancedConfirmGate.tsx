/**
 * Below-minimum advanced-confirmation gate (Task 26, NEW FILE — design UI).
 *
 * Implements the ram-ui.md §3 gate DIALOG only: it shows the three figures +
 * source chip + ramNotes, requires an explicit checkbox acknowledgement (never
 * a single "OK" tap), and adds a second confirmation step for large entries.
 * Recording the decision to the diagnostics log, native free-RAM wiring, and
 * enforcement are later tasks — this component only collects the explicit
 * consent and reports it via callbacks.
 */

import { useId } from "react";
import type { ModelCatalogueEntry } from "../services/models/catalogueTypes";
import {
  describeRamFigures,
  ramSourceChip,
  type AvailableFreeRamMb,
} from "../services/models/ramPolicy";

export interface ModelAdvancedConfirmGateProps {
  entry: ModelCatalogueEntry;
  availableFreeRamMb: AvailableFreeRamMb;
  /** First acknowledgement checkbox state (controlled by the caller). */
  acknowledged: boolean;
  onAcknowledgedChange: (checked: boolean) => void;
  /**
   * Second confirmation for large entries (controlled). Required only when
   * `requireSecondConfirm` is true.
   */
  secondConfirmed?: boolean;
  onSecondConfirmedChange?: (checked: boolean) => void;
  /** True for `catalogOnly`/large entries needing the two-step gate. */
  requireSecondConfirm?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ModelAdvancedConfirmGate({
  entry,
  availableFreeRamMb,
  acknowledged,
  onAcknowledgedChange,
  secondConfirmed = false,
  onSecondConfirmedChange,
  requireSecondConfirm = false,
  onConfirm,
  onCancel,
}: ModelAdvancedConfirmGateProps) {
  const figures = describeRamFigures(entry, availableFreeRamMb);
  const titleId = useId();
  const ackId = useId();
  const secondId = useId();
  const canConfirm = acknowledged && (!requireSecondConfirm || secondConfirmed);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="model-advanced-confirm-gate"
      className="rounded-m3-sm border border-outline-variant bg-surface p-4"
    >
      <h2 id={titleId} className="text-base font-semibold text-on-surface">
        Advanced confirmation required
      </h2>

      <ul className="mt-2 space-y-0.5 text-sm text-on-surface" aria-label="Memory figures">
        <li>{figures.minimumLabel}</li>
        <li>{figures.recommendedLabel}</li>
        <li>{figures.deviceNowLabel}</li>
      </ul>

      <p className="mt-2">
        <span
          data-testid="model-gate-source-chip"
          className="rounded-full bg-surface-container px-2 py-0.5 text-xs text-on-surface-variant"
        >
          {ramSourceChip(entry.ramRequirementSource)}
        </span>
      </p>

      {entry.ramNotes ? (
        <p data-testid="model-gate-ram-notes" className="mt-1 text-xs text-on-surface-variant">
          {entry.ramNotes}
        </p>
      ) : null}

      <p className="mt-2 text-xs text-on-surface-variant">
        Checksum verification and the data-only package ban still apply — this
        confirmation cannot bypass them.
      </p>

      <label
        htmlFor={ackId}
        className="mt-3 flex min-h-[48px] cursor-pointer items-start gap-2 text-sm text-on-surface"
      >
        <input
          id={ackId}
          type="checkbox"
          data-testid="model-gate-acknowledge"
          checked={acknowledged}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
          className="mt-1 h-5 w-5"
        />
        <span>
          I understand this model needs {figures.minimumLabel.replace("Minimum free RAM ", "")} free
          and my device reports {figures.deviceNowLabel.replace("Your device now: ", "")}.
        </span>
      </label>

      {requireSecondConfirm ? (
        <label
          htmlFor={secondId}
          className="mt-2 flex min-h-[48px] cursor-pointer items-start gap-2 text-sm text-on-surface"
        >
          <input
            id={secondId}
            type="checkbox"
            data-testid="model-gate-second-confirm"
            checked={secondConfirmed}
            onChange={(event) => onSecondConfirmedChange?.(event.target.checked)}
            className="mt-1 h-5 w-5"
          />
          <span>Advanced: run unverified large model.</span>
        </label>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          data-testid="model-gate-cancel"
          onClick={onCancel}
          className="flex min-h-[48px] flex-1 items-center justify-center rounded-m3-sm border border-outline px-4 text-sm font-medium text-on-surface"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="model-gate-confirm"
          onClick={onConfirm}
          disabled={!canConfirm}
          className="flex min-h-[48px] flex-1 items-center justify-center rounded-m3-sm bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-50"
        >
          Confirm
        </button>
      </div>
    </div>
  );
}
