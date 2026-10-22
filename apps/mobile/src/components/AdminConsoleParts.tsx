/**
 * The two console fragments that appear on more than one surface.
 *
 * They live here so the visual fixture route can render the SAME markup the
 * screens render, instead of a hand-copied approximation that drifts. Nothing
 * here fetches: both take what the screen already knows.
 */
import { capabilityLabels, roleWord } from "./adminConsole";

/** The person (or invitation) an access grant would replace. */
export interface ReplaceTarget {
  email: string;
  role: string;
  capabilities: readonly string[];
}

/**
 * "They already have a role — giving access again REPLACES it."
 *
 * Shown before the control can be pressed, and the checkbox is the only way
 * past it. A null `target` means the membership list could not be read, so the
 * fragment says that rather than pretending the address is new.
 */
export function AdminReplaceWarning({
  target,
  acknowledged,
  disabled = false,
  onAcknowledged,
}: {
  target: ReplaceTarget | null;
  acknowledged: boolean;
  disabled?: boolean;
  onAcknowledged: (acknowledged: boolean) => void;
}) {
  return (
    <div className="fb-admin-warning" role="note">
      {target ? (
        <p>
          {target.email} already has {roleWord(target.role)} access
          {target.capabilities.length > 0
            ? ` with ${capabilityLabels(target.capabilities).join(", ")}`
            : ""}
          .
        </p>
      ) : (
        <p>We could not check whether this address already has a role.</p>
      )}
      <p>
        Giving access again replaces the current role and permissions with what
        you choose on this screen.
      </p>
      <label className="fb-admin-ack">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={disabled}
          onChange={(event) => onAcknowledged(event.target.checked)}
        />
        Replace their current role and permissions
      </label>
    </div>
  );
}

/** One line of the append-only log, as a reader sees it. */
export function AdminAuditLine({
  headline,
  detail,
  time,
}: {
  headline: string;
  detail: string | null;
  time: string;
}) {
  return (
    <li className="fb-admin-log-row">
      <p className="fb-admin-log-headline">{headline}</p>
      {detail && <p className="fb-admin-log-detail">{detail}</p>}
      {time && <p className="fb-admin-log-time">{time}</p>}
    </li>
  );
}
