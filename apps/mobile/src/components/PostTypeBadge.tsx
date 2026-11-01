import { CircleAlert, CircleCheck } from "lucide-react";
import type { PostType } from "@findback/shared";

/**
 * The one Lost/Found badge. Reuses the home-feed badge primitives and always
 * carries text plus an icon, so the report type never depends on colour alone.
 * Surfaces pass their own `testId` to keep their existing test contract.
 */
export function PostTypeBadge({ type, testId }: { type?: PostType | null; testId?: string }) {
  // A loosely typed fixture may omit the type. Never guess a side of the match.
  if (type !== "LOST" && type !== "FOUND") return null;
  const lost = type === "LOST";
  return (
    <span data-testid={testId} className={`fb-type-badge ${lost ? "fb-type-lost" : "fb-type-found"}`}>
      {lost ? <CircleAlert size={14} aria-hidden /> : <CircleCheck size={14} aria-hidden />}
      {lost ? "Lost" : "Found"}
    </span>
  );
}
