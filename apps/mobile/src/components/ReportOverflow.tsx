import type { PostItem } from "@findback/shared";
import { Bookmark } from "lucide-react";
import { SafetyActions } from "./SafetyActions";
import { useSavePostAction } from "./SavePostButton";

/** Composes existing account-fenced owners; no second saved/report/block state. */
export function ReportOverflow({ post }: { post: PostItem }) {
  const save = useSavePostAction(post.id, post.title);
  return <SafetyActions
    content={{ targetType: "POST", targetId: post.id }}
    person={{ userId: post.author.id, name: post.author.displayName || post.author.username }}
    actions={[{ id: "save", label: save.label, disabled: !save.hasAccount,
      icon: <Bookmark size={18} aria-hidden fill={save.saved ? "currentColor" : "none"} />,
      onAction: () => { void save.onAction(); },
    }]}
  />;
}
