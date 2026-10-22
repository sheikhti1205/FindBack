import { useState } from "react";
import { AdminCapabilityMatrix } from "../../components/AdminCapabilityMatrix";
import { AdminAuditLine, AdminReplaceWarning } from "../../components/AdminConsoleParts";
import { describeActivity } from "../../components/adminConsole";
import type { AuditEntry } from "../../services/roles";
import { FixtureFrame, FixtureSection } from "../FixtureSection";
import "../../components/AdminConsole.css";

/**
 * The staff console's shared pieces, at the widths a phone actually has.
 *
 * The three screens fetch their own data, so they cannot be mounted here
 * without a network — but everything a reader judges them by (the permission
 * editor, the replacement warning, a log line in words) is a component with
 * props. This section renders those production components, so a screenshot at
 * 320dp is evidence about the real markup and the real `AdminConsole.css`.
 */

const LONG_EMAIL = "sheikhti109.moderator.account@outlook.example.com";

const ENTRIES: AuditEntry[] = [
  {
    id: "a3",
    actorUserId: "u-admin",
    action: "INVITATION_REVOKED",
    targetType: "role_invitations",
    targetId: "new@example.com",
    reason: "Invitation revoked",
    previousState: { role: "MODERATOR", capabilities: ["reports_review"] },
    newState: { role: "MODERATOR", capabilities: ["reports_review"], revoked: true },
    createdAt: "2026-10-22T11:20:00.000Z",
  },
  {
    id: "a2",
    actorUserId: "u-admin",
    action: "CAPABILITIES_CHANGED",
    targetType: "user_role_capabilities",
    targetId: "u-sam",
    reason: "Capability set changed",
    previousState: { capabilities: ["reports_review"] },
    newState: { capabilities: ["reports_review", "content_hide"] },
    createdAt: "2026-10-22T10:05:00.000Z",
  },
  {
    id: "a1",
    actorUserId: "u-admin",
    action: "ROLE_GRANTED",
    targetType: "user_roles",
    targetId: LONG_EMAIL,
    reason: "Role granted",
    previousState: { role: null, capabilities: [] },
    newState: { role: "MODERATOR", capabilities: ["reports_review"] },
    createdAt: "2026-10-21T18:40:00.000Z",
  },
];

function Editor({ width }: { width?: number }) {
  return (
    <FixtureFrame section="admin" variant={width === 320 ? "small-width" : "normal"} width={width}>
      <div className="flex max-w-[30rem] flex-col px-4 py-3">
        <AdminCapabilityMatrix
          email={LONG_EMAIL}
          personLabel={LONG_EMAIL}
          initialCapabilities={["reports_review"]}
          onCancel={() => {}}
          onSaved={() => {}}
        />
      </div>
    </FixtureFrame>
  );
}

function Warning({ width }: { width?: number }) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <FixtureFrame section="admin" variant={width === 320 ? "small-width" : "normal"} width={width}>
      <AdminReplaceWarning
        target={{ email: LONG_EMAIL, role: "MODERATOR", capabilities: ["reports_review", "content_hide"] }}
        acknowledged={acknowledged}
        onAcknowledged={setAcknowledged}
      />
    </FixtureFrame>
  );
}

export function AdminFixtures() {
  return (
    <FixtureSection
      id="admin"
      title="Staff console"
      description="The permission editor, the replacement warning and the activity log, at 320dp and in dark."
    >
      <Editor />
      <Editor width={320} />
      <FixtureFrame section="admin" variant="dark">
        <div className="flex max-w-[30rem] flex-col px-4 py-3">
          <AdminCapabilityMatrix
            email={LONG_EMAIL}
            personLabel={LONG_EMAIL}
            initialCapabilities={["reports_review", "content_hide"]}
            onCancel={() => {}}
            onSaved={() => {}}
          />
        </div>
      </FixtureFrame>

      <Warning />
      <Warning width={320} />
      <FixtureFrame section="admin" variant="dark">
        <AdminReplaceWarning
          target={null}
          acknowledged={false}
          onAcknowledged={() => {}}
        />
      </FixtureFrame>

      <FixtureFrame section="admin" variant="normal">
        <ol className="fb-admin-log">
          {ENTRIES.map((entry) => {
            const line = describeActivity(entry);
            return (
              <AdminAuditLine
                key={entry.id}
                headline={line.headline}
                detail={line.detail}
                time={line.time}
              />
            );
          })}
        </ol>
      </FixtureFrame>
      <FixtureFrame section="admin" variant="small-width" width={320}>
        <ol className="fb-admin-log">
          {ENTRIES.map((entry) => {
            const line = describeActivity(entry);
            return (
              <AdminAuditLine
                key={entry.id}
                headline={line.headline}
                detail={line.detail}
                time={line.time}
              />
            );
          })}
        </ol>
      </FixtureFrame>
      <FixtureFrame section="admin" variant="empty">
        <p className="fb-admin-note">Nothing has happened yet.</p>
      </FixtureFrame>
    </FixtureSection>
  );
}
