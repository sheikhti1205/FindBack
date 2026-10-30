import { useEffect, useRef, useState } from "react";
import { ApiError } from "../services/session";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import { History, UserPlus } from "lucide-react";
import {
  fetchMyRole,
  listRoleAssignments,
  listRoleInvitations,
  revokeRole,
  type MyRole,
  type RoleAssignment,
  type RoleInvitation,
} from "../services/roles";
import { Button } from "../components/Button";
import { AdminCapabilityMatrix } from "../components/AdminCapabilityMatrix";
import { SettingsGroup, SettingsPage, SettingsRow, StatusPill } from "../components/settings";
import {
  ROLE_LABELS,
  adminErrorMessage,
  describeCapabilities,
} from "../components/adminConsole";
import "../components/AdminConsole.css";

/**
 * The team (integrator: mount at `/settings/team`).
 *
 * Who holds a role, what each of them may do, and the two things the admin
 * can do about it: change a person's permissions, or take the role away.
 *
 * The server is the authority for all of it. The list is read with
 * `listRoleAssignments`, which only an admin may call; when the server
 * refuses, the refusal is shown as a sentence. Nothing here decides who may
 * moderate — the admin-only surfaces are offered only when the server says
 * this account is an admin.
 */
export function AdminTeam() {
  const alive = useSafetyLifetime();
  const accessLost = useRef(false);
  const pendingWrite = useRef(false);
  const [myRole, setMyRole] = useState<MyRole | null>(null);
  const [people, setPeople] = useState<RoleAssignment[] | null>(null);
  const [invites, setInvites] = useState<RoleInvitation[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    email: string;
    label: string;
    capabilities: string[];
  } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function loseAccess() {
    accessLost.current = true;
    setMyRole(null); setPeople(null); setInvites(null); setEditing(null);
    setConfirming(null); setSavedNote(null);
  }

  useEffect(() => {
    let cancelled = false;
    void fetchMyRole()
      .then((role) => {
        if (!cancelled && !accessLost.current) setMyRole(role);
      })
      .catch(() => {
        // An unreadable role means the console offers nothing: the server
        // refuses everything an ordinary account asks for anyway.
        if (!cancelled) setMyRole(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([listRoleAssignments(), listRoleInvitations()]).then(
      ([peopleResult, invitesResult]) => {
        if (cancelled) return;
        const denied = [peopleResult, invitesResult].some(result => result.status === "rejected" && result.reason instanceof ApiError && (result.reason.status === 401 || result.reason.status === 403));
        if (denied) {
          loseAccess(); setListError("Only an admin can see the team list."); setLoading(false); return;
        }
        if (peopleResult.status === "fulfilled") setPeople(peopleResult.value);
        if (invitesResult.status === "fulfilled") setInvites(invitesResult.value);
        const failure =
          peopleResult.status === "rejected"
            ? peopleResult.reason
            : invitesResult.status === "rejected"
              ? invitesResult.reason
              : null;
        if (failure) {
          setListError(
            adminErrorMessage(failure, "Only an admin can see the team list."),
          );
        }
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const pending = (invites ?? []).filter(
    (invite) => invite.acceptedAt === null && invite.revokedAt === null,
  );

  async function refresh() {
    // A completed write may outlive its route/account. Never issue readback
    // with whichever principal happens to own the client after that boundary.
    if (!alive.current || accessLost.current) return;
    const [peopleResult, invitesResult] = await Promise.allSettled([
      listRoleAssignments(),
      listRoleInvitations(),
    ]);
    if (!alive.current || accessLost.current) return;
    const denied = [peopleResult, invitesResult].some(result => result.status === "rejected" && result.reason instanceof ApiError && (result.reason.status === 401 || result.reason.status === 403));
    if (denied) { loseAccess(); setListError("Only an admin can see the team list."); return; }
    if (peopleResult.status === "fulfilled") setPeople(peopleResult.value);
    if (invitesResult.status === "fulfilled") setInvites(invitesResult.value);
  }

  async function remove(email: string) {
    if (pendingWrite.current || accessLost.current) return;
    pendingWrite.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await revokeRole(email);
      if (!alive.current) return;
      setConfirming(null);
      await refresh();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) loseAccess();
      setActionError(
        adminErrorMessage(err, "Only an admin may take a role away."),
      );
    } finally {
      pendingWrite.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const isAdmin = myRole?.isAdmin === true;
  const canReadLog = myRole?.capabilities.includes("audit_read") === true;
  const empty = !loading && !listError && (people ?? []).length === 0 && pending.length === 0;

  return (
    <SettingsPage
      title={"Team & permissions"}
      description="Who can moderate FindBack, and what each of them may do."
      backTo="/settings"
    >
      <SettingsGroup title="People with a role">
        {savedNote && (
          <p role="status" className="fb-admin-note">
            {savedNote}
          </p>
        )}
        {loading && (
          <p role="status" className="fb-admin-note">
            Loading the team…
          </p>
        )}
        {listError && (
          <p role="alert" className="fb-admin-error">
            {listError}
          </p>
        )}
        {empty && (
          <p className="fb-admin-note">
            No moderators yet. Add someone by email to give them moderator access.
          </p>
        )}
        {(people ?? []).length > 0 && (
          <ul className="fb-admin-list">
            {(people ?? []).map((person) => (
              <PersonRow
                key={person.email}
                person={person}
                busy={busy}
                confirming={confirming === person.email}
                onEdit={() =>
                  setEditing({
                    email: person.email,
                    label: person.email,
                    capabilities: [...person.capabilities],
                  })
                }
                onAskRemove={() => setConfirming(person.email)}
                onKeep={() => setConfirming(null)}
                onRemove={() => void remove(person.email)}
              />
            ))}
          </ul>
        )}
      </SettingsGroup>

      {pending.length > 0 && (
        <SettingsGroup
          title="Waiting to join"
          description="We will activate these as soon as the person signs up with that address."
        >
          <ul className="fb-admin-list">
            {pending.map((invite) => (
              <PersonRow
                key={invite.id}
                person={{
                  userId: invite.id,
                  username: "",
                  email: invite.email,
                  role: invite.role,
                  capabilities: invite.capabilities,
                  grantedAt: invite.invitedAt,
                }}
                busy={busy}
                confirming={confirming === invite.email}
                onEdit={() =>
                  setEditing({
                    email: invite.email,
                    label: invite.email,
                    capabilities: [...invite.capabilities],
                  })
                }
                onAskRemove={() => setConfirming(invite.email)}
                onKeep={() => setConfirming(null)}
                onRemove={() => void remove(invite.email)}
                removeLabel="Cancel invitation"
              />
            ))}
          </ul>
        </SettingsGroup>
      )}

      {editing && (
        <SettingsGroup title={`Permissions for ${editing.label}`}>
          <AdminCapabilityMatrix
            key={editing.email}
            email={editing.email}
            personLabel={editing.label}
            initialCapabilities={editing.capabilities}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              if (!alive.current || accessLost.current) return;
              // The editor unmounts here, so the confirmation belongs to the
              // page it returns to, not to a component that is gone.
              setSavedNote(`Saved. ${editing.label} has the permissions shown here now.`);
              setEditing(null);
              void refresh();
            }}
            onAccessDenied={() => {
              loseAccess(); setActionError("Only an admin may change what a person may do.");
            }}
          />
        </SettingsGroup>
      )}

      {(isAdmin || canReadLog) && (
        <SettingsGroup title="Manage">
          {isAdmin && (
            <SettingsRow
              title="Add a moderator"
              description="Give access by email address."
              icon={UserPlus}
              iconTone="account"
              route="/settings/team/invite"
            />
          )}
          {canReadLog && (
            <SettingsRow
              title="Activity log"
              description="Every role and permission change, newest first."
              icon={History}
              iconTone="privacy"
              route="/settings/team/audit"
            />
          )}
        </SettingsGroup>
      )}

      {actionError && (
        <p role="alert" className="fb-admin-error">
          {actionError}
        </p>
      )}
    </SettingsPage>
  );
}

/**
 * One person, or one pending invitation.
 *
 * An admin holds everything, so their permissions are not editable — the
 * server refuses to change an admin's set. A moderator's permissions are the
 * admin's to decide, one box at a time.
 */
function PersonRow({
  person,
  busy,
  confirming,
  onEdit,
  onAskRemove,
  onKeep,
  onRemove,
  removeLabel = "Remove role",
}: {
  person: RoleAssignment;
  busy: boolean;
  confirming: boolean;
  onEdit: () => void;
  onAskRemove: () => void;
  onKeep: () => void;
  onRemove: () => void;
  removeLabel?: string;
}) {
  const isAdmin = person.role === "ADMIN";
  const name = person.username || person.email;
  return (
    <li className="fb-admin-person">
      <div className="fb-admin-person-head">
        <div>
          <p className="fb-admin-person-name">{name}</p>
          {person.username && (
            <p className="fb-admin-person-email">{person.email}</p>
          )}
        </div>
        <StatusPill tone={isAdmin ? "accent" : "neutral"}>
          {ROLE_LABELS[person.role] ?? person.role}
        </StatusPill>
      </div>
      <p className="fb-admin-person-caps">
        {isAdmin
          ? "Full access — the admin can do everything, including managing roles."
          : describeCapabilities(person.capabilities)}
      </p>
      <div className="fb-admin-actions">
        {!isAdmin && (
          <Button variant="outline" onClick={onEdit}>
            Change permissions
          </Button>
        )}
        {!confirming && (
          <Button variant="text" onClick={onAskRemove}>
            {removeLabel}
          </Button>
        )}
      </div>
      {confirming && (
        <div className="fb-admin-confirm">
          <p className="fb-admin-note">
            {isAdmin
              ? `Take the admin role away from ${person.email}? The last admin cannot be removed.`
              : `Take the moderator role away from ${person.email}? Their access ends immediately.`}
          </p>
          <div className="fb-admin-actions">
            <Button variant="error" loading={busy} onClick={onRemove}>
              Yes, {removeLabel.toLowerCase()}
            </Button>
            <Button variant="text" disabled={busy} onClick={onKeep}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
