import { useAuth } from "../auth";
import { Button } from "./Button";

/** Auth-owned outcome survives RequireAuth redirect and persistent-vault failure. */
export function AccountDeletionFeedback() {
  const { user, deletionCompletion: completion, retryDeletionCleanup, dismissDeletionCompletion } = useAuth();
  if (!completion || user) return null;
  return (
    <section aria-label="Account deletion" className="mx-auto w-full max-w-lg border-b border-outline-variant bg-surface px-4 py-3 text-on-surface">
      <p role={completion.state === "cleanup-failed" ? "alert" : "status"} className="text-sm">
        Your account was permanently deleted.
        {completion.state === "complete" ? " This device is signed out and its stored AI keys were removed." : completion.state === "cleaning" ? " Finishing cleanup on this device…" : " Cleanup on this device did not finish. Retry to finish signing out and removing stored AI keys."}
      </p>
      {completion.state === "cleanup-failed" ? <Button variant="text" onClick={() => void retryDeletionCleanup()}>Retry cleanup</Button> : null}
      {completion.state === "complete" ? <Button variant="text" onClick={dismissDeletionCompletion}>Dismiss</Button> : null}
    </section>
  );
}
