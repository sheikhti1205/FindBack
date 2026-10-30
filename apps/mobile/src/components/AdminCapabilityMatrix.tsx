import { useId, useRef, useState } from "react";
import { ApiError } from "../services/session";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import { Button } from "./Button";
import {
  MODERATOR_CAPABILITIES,
  setRoleCapabilities,
} from "../services/roles";
import {
  adminErrorMessage,
  adminOnlySummary,
  capabilityLabel,
  capabilityLabels,
} from "./adminConsole";
import "./AdminConsole.css";

/**
 * The permission checklist — ONE checkbox group for the whole console.
 *
 * The invite screen and the capability editor both need "one box per
 * permission the server can grant a moderator", so they share this one. It is
 * a labelled group (`fieldset` + `legend`), every box is a real native
 * checkbox with the permission's human label, and the admin-only permissions
 * are never in it: the server refuses them for a moderator, so they are not
 * offered here either.
 */
export interface CapabilityChecklistProps {
  /** The capability ids that are ticked right now. */
  selected: readonly string[];
  /** Called with the capability id and its new state. */
  onToggle: (capability: string, checked: boolean) => void;
  /** The group's label; announced as the group's name. */
  legend: string;
  /** One line of guidance under the label. */
  description?: string;
  /** True while the boxes must not be touched. */
  disabled?: boolean;
  className?: string;
}

export function CapabilityChecklist({
  selected,
  onToggle,
  legend,
  description,
  disabled = false,
  className = "",
}: CapabilityChecklistProps) {
  const descriptionId = useId();
  return (
    <fieldset
      className={`fb-admin-fieldset ${className}`}
      aria-describedby={description ? descriptionId : undefined}
    >
      <legend className="fb-admin-legend">{legend}</legend>
      {description && <p id={descriptionId} className="fb-admin-hint">{description}</p>}
      <ul className="fb-admin-capability-list">
        {MODERATOR_CAPABILITIES.map((capability) => {
          const checked = selected.includes(capability);
          return (
            <li key={capability}>
              <label className="fb-admin-capability" data-checked={checked ? "true" : "false"}>
                <input
                  type="checkbox"
                  className="fb-admin-checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(event) => onToggle(capability, event.target.checked)}
                />
                <span className="fb-admin-capability-text">{capabilityLabel(capability)}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/**
 * The per-person permission editor.
 *
 * The admin ticks the permissions one person may use, sees what changed, and
 * saves it. The server owns the decision: the save goes through
 * `setRoleCapabilities`, and a refusal (403) is shown as a sentence, not as a
 * crash. Cancel leaves the person's permissions exactly as they were.
 */
export interface AdminCapabilityMatrixProps {
  /** The person's email address — the server identifies them by address. */
  email: string;
  /** How the person is named in the heading. */
  personLabel: string;
  /** The permissions they hold right now. */
  initialCapabilities: readonly string[];
  /** Called when the admin closes the editor without saving. */
  onCancel: () => void;
  /** Called after the server accepted the new set. */
  onSaved?: (capabilities: string[]) => void;
  /** Purge the owning team's private state after a server authorization refusal. */
  onAccessDenied?: () => void;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sorted = [...left].sort();
  const other = [...right].sort();
  return sorted.every((value, index) => value === other[index]);
}

export function AdminCapabilityMatrix({
  email,
  personLabel,
  initialCapabilities,
  onCancel,
  onSaved,
  onAccessDenied,
}: AdminCapabilityMatrixProps) {
  const alive = useSafetyLifetime();
  const pending = useRef(false);
  const [accessLost, setAccessLost] = useState(false);
  const [selected, setSelected] = useState<string[]>(() => [...initialCapabilities]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The set the server accepted, once it has accepted one. */
  const [savedSet, setSavedSet] = useState<string[] | null>(null);

  // The parent re-reads the team after a save, so a new set of permissions
  // arrives here; the editor follows it instead of keeping a stale draft.
  const incoming = [...initialCapabilities].sort().join("|");
  const [seenIncoming, setSeenIncoming] = useState(incoming);
  if (incoming !== seenIncoming) {
    setSeenIncoming(incoming);
    setSelected([...initialCapabilities]);
  }

  // What the editor is compared against: the set the server last accepted,
  // or the set this person was given when the editor opened.
  const baseline = savedSet ?? [...initialCapabilities];
  const dirty = !sameSet(selected, baseline);
  const added = selected.filter((capability) => !baseline.includes(capability));
  const removed = baseline.filter((capability) => !selected.includes(capability));

  function toggle(capability: string, checked: boolean) {
    setError(null);
    setSelected((current) =>
      checked
        ? current.includes(capability)
          ? current
          : [...current, capability]
        : current.filter((item) => item !== capability),
    );
  }

  async function save() {
    if (pending.current || accessLost || !dirty) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      await setRoleCapabilities(email, selected);
      if (!alive.current) return;
      setSavedSet([...selected]);
      onSaved?.(selected);
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setSelected([]); setSavedSet(null); setAccessLost(true); onAccessDenied?.();
      }
      setError(
        adminErrorMessage(err, "Only an admin may change what a person may do."),
      );
    } finally {
      pending.current = false;
      if (alive.current) setSaving(false);
    }
  }

  return (
    <div className="fb-admin-matrix">
      <p className="fb-admin-note">
        {personLabel} may use these. Anything unticked is refused.
      </p>
      <CapabilityChecklist
        selected={selected}
        onToggle={toggle}
        legend="What this person may do"
        description="Tick only what they need. You can change it at any time."
        disabled={saving || accessLost}
      />
      <p className="fb-admin-note fb-admin-held">
        These stay with the admin and are never given to a moderator:{" "}
        {adminOnlySummary()}.
      </p>
      {dirty ? (
        <p className="fb-admin-change">
          {added.length > 0 && <>Added: {capabilityLabels(added).join(", ")}. </>}
          {removed.length > 0 && <>Removed: {capabilityLabels(removed).join(", ")}.</>}
        </p>
      ) : savedSet === null ? (
        <p className="fb-admin-note">No changes yet.</p>
      ) : null}
      <div className="fb-admin-actions">
        <Button onClick={() => void save()} loading={saving} disabled={!dirty || accessLost}>
          Save permissions
        </Button>
        <Button variant="text" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="fb-admin-error">
          {error}
        </p>
      )}
    </div>
  );
}
