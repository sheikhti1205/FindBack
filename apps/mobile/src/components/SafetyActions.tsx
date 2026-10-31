import { useState } from "react";
import { Flag, UserRoundMinus } from "lucide-react";
import { useAuth } from "../auth";
import { ReportSheet } from "./ReportSheet";
import { BlockControl } from "./BlockControl";
import { ActionMenu, type MenuAction } from "./ActionMenu";
import { AdaptiveTaskSurface } from "./AdaptiveTaskSurface";
import type { ReportTargetType } from "../services/moderation";

export interface SafetyActionsProps {
  /**
   * The content being reported, when the surface has one.
   *
   * A post or a comment. A profile has no content, only a person.
   */
  content?: { targetType: Extract<ReportTargetType, "POST" | "COMMENT">; targetId: string };
  /**
   * The person behind the surface, when it is known.
   *
   * A post's author, a comment's author, a message's sender, or the profile's owner. The name is
   * a name — never an id — because it appears in a sentence.
   */
  person?: { userId: string; name: string };
  /**
   * Also offer "report this person".
   *
   * True on a profile: the thing on the surface IS the person. On a post, a comment
   * or a message the content is the subject, and the author/sender is offered the
   * block control instead.
   */
  reportPerson?: boolean;
  className?: string;
  /** Feature-owned actions share the same menu, never the safety permissions. */
  actions?: readonly MenuAction[];
}

/**
 * Compact safety overflow for content and public profiles.
 *
 * No new report/block owner: both actions enter the canonical controls.
 * Account and target changes discard open menus/forms. Block membership is
 * read only when the reader opens that action, never on every feed/profile row.
 */
export function SafetyActions(props: SafetyActionsProps) {
  const { user } = useAuth();
  if (!user) return null;
  const canReport = user.id !== props.person?.userId && Boolean(props.content || (props.reportPerson && props.person));
  if (!canReport && !props.actions?.length) return null;
  return <ScopedSafetyActions key={JSON.stringify([user.id, props.content?.targetType, props.content?.targetId, props.person?.userId, props.reportPerson])} {...props} canReport={canReport} />;
}

function ScopedSafetyActions({ content, person, reportPerson = false, className, actions = [], canReport }: SafetyActionsProps & { canReport: boolean }) {
  const [reportOpen, setReportOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const subject = content?.targetType === "COMMENT" ? "comment" : content ? "report" : "profile";
  const target = content ?? (reportPerson && person ? { targetType: "USER" as const, targetId: person.userId } : null);
  const reportLabel = content?.targetType === "COMMENT" ? "Report comment" : content ? "Report post" : "Report user";

  return (
    <div className={`shrink-0 ${className ?? ""}`} onPointerDown={(event) => event.stopPropagation()}>
      <ActionMenu label={`More ${subject} actions`} items={[
        ...actions,
        ...(canReport ? [{ id: "report", label: reportLabel, icon: <Flag size={18} aria-hidden="true" />, onAction: () => setReportOpen(true) }] : []),
        ...(canReport && person ? [{ id: "block", label: "Block account", destructive: true, icon: <UserRoundMinus size={18} aria-hidden="true" />, onAction: () => setBlockOpen(true) }] : []),
      ]} />
      <ReportSheet open={reportOpen} target={target} onClose={() => setReportOpen(false)} />
      <AdaptiveTaskSurface open={blockOpen} title="Block account" onClose={() => setBlockOpen(false)}>
        {blockOpen && person && <BlockControl userId={person.userId} name={person.name} />}
      </AdaptiveTaskSurface>
    </div>
  );
}
