import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  grantRole,
  listRoleAssignments,
  type AdminRole,
  type GrantOutcome,
  type RoleAssignment,
} from "../services/roles";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { CapabilityChecklist } from "../components/AdminCapabilityMatrix";
import { PreferenceRadioRow, SettingsGroup, SettingsPage } from "../components/settings";
import { adminErrorMessage, roleWord } from "../components/adminConsole";
import { AdminReplaceWarning } from "../components/AdminConsoleParts";
import "../components/AdminConsole.css";

/** The same shape the server accepts, checked here so nothing silly is sent. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Add someone to the team (integrator: mount at `/settings/team/invite`).
 *
 * People are hired through Discord and then given their role here, by email.
 * The person does not need an account yet: the server either grants the role
 * straight away, or keeps it as an invitation until they sign up with that
 * address. The screen says which one happened — it never claims more than the
 * server did.
 */
export function AdminInvite() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminRole>("MODERATOR");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<GrantOutcome | null>(null);
  const [members, setMembers] = useState<RoleAssignment[] | null>(null);
  const [replaceAcknowledged, setReplaceAcknowledged] = useState(false);
  const [membershipUnknown, setMembershipUnknown] = useState(false);

  // Who already holds a role. A failed read is not fatal: the address is then
  // treated as new, and the server stays the authority on what it did.
  useEffect(() => {
    let alive = true;
    void listRoleAssignments()
      .then((rows) => {
        if (alive) setMembers(rows);
      })
      .catch(() => {
        if (!alive) return;
        // The list could not be read: the address might already hold a role,
        // so the admin is asked to acknowledge a replacement rather than the
        // screen pretending the address is new.
        setMembershipUnknown(true);
        setMembers([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const address = email.trim().toLowerCase();
  const existing = useMemo(
    () => members?.find((person) => person.email.trim().toLowerCase() === address) ?? null,
    [members, address],
  );
  const replacing = existing !== null || membershipUnknown;
  const blocked = replacing && !replaceAcknowledged;

  function toggle(capability: string, checked: boolean) {
    setError(null);
    setCapabilities((current) =>
      checked
        ? current.includes(capability)
          ? current
          : [...current, capability]
        : current.filter((item) => item !== capability),
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(address)) {
      setFieldError("Enter a valid email address.");
      return;
    }
    if (blocked) {
      setFieldError("Confirm that replacing an existing role is what you intend.");
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    setError(null);
    setOutcome(null);
    try {
      // An admin holds every permission, so no box is ticked for them: the
      // server decides what an admin may do.
      const granted = await grantRole(
        address,
        role,
        role === "ADMIN" ? [] : capabilities,
      );
      setOutcome(granted);
      setEmail("");
      setCapabilities([]);
      setReplaceAcknowledged(false);
    } catch (err) {
      setOutcome(null);
      setError(adminErrorMessage(err, "Only an admin may give someone a role."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SettingsPage
      title="Give someone access"
      description="Give someone a role by email. They can start as soon as they sign up with that address."
      backTo="/settings/team"
    >
      <SettingsGroup title="Who is joining">
        <form
          className="fb-admin-form"
          // The app checks the address itself, so the message is in the app's
          // own voice instead of the browser's.
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          <TextField
            label="Email address"
            type="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="name@example.com"
            value={email}
            disabled={submitting}
            onChange={(event) => {
              setEmail(event.target.value);
              // A tick belongs to one address; the next person must not
              // inherit it.
              setReplaceAcknowledged(false);
            }}
            hint="The address they will sign up with."
            error={fieldError ?? undefined}
          />
          <fieldset className="fb-choice-fieldset">
            <legend className="fb-admin-legend">Role</legend>
            <div className="fb-choice-list">
              <PreferenceRadioRow
                name="admin-invite-role"
                value="MODERATOR"
                title="Moderator"
                description="Handles reports and content, within the permissions you choose."
                checked={role === "MODERATOR"}
                onChange={() => setRole("MODERATOR")}
                disabled={submitting}
              />
              <PreferenceRadioRow
                name="admin-invite-role"
                value="ADMIN"
                title="Admin"
                description="Can do everything, including managing roles."
                checked={role === "ADMIN"}
                onChange={() => setRole("ADMIN")}
                disabled={submitting}
              />
            </div>
          </fieldset>
          {role === "MODERATOR" ? (
            <CapabilityChecklist
              selected={capabilities}
              onToggle={toggle}
              legend="What this person may do"
              description="Tick only what they need. You can change it at any time."
              disabled={submitting}
            />
          ) : (
            <p className="fb-admin-note fb-admin-held">
              An admin can do everything, including managing roles and
              permissions. Nothing needs to be ticked.
            </p>
          )}
          {replacing && (
            <AdminReplaceWarning
              target={existing}
              acknowledged={replaceAcknowledged}
              disabled={submitting}
              onAcknowledged={setReplaceAcknowledged}
            />
          )}
          <div className="fb-admin-actions">
            <Button type="submit" loading={submitting} disabled={blocked}>
              Give access
            </Button>
          </div>
        </form>
        {error && (
          <p role="alert" className="fb-admin-error">
            {error}
          </p>
        )}
      </SettingsGroup>

      {outcome && (
        <SettingsGroup title="Done">
          <p role="status" className="fb-admin-note">
            {outcome.kind === "account"
              ? `${outcome.email} now has ${roleWord(outcome.role)} access. They can sign in with that address now.`
              : `${outcome.email} will get ${roleWord(outcome.role)} access as soon as they sign up with that address. We will activate it when they sign up with that address.`}
          </p>
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
