import { useAuth } from "../auth";
import { Button } from "./Button";

/** Auth-owned outcome survives RequireAuth redirect and persistent-vault failure. */
export function AccountDeletionFeedback() {
  const { user, deletionCompletion: completion, deletionRecoveryError, retryDeletionCleanup, dismissDeletionCompletion } = useAuth();
  // Inventory errors are device-wide and need a retry even over a replacement
  // account. Only the generic error may cross that boundary, never A's outcome.
  if (!deletionRecoveryError && (user || !completion)) return null;
  const failed = deletionRecoveryError || completion?.state === "cleanup-failed";
  return (
    <section aria-label={deletionRecoveryError ? "Device cleanup" : "Account deletion"} className="mx-auto w-full max-w-lg space-y-2 border-b border-outline-variant bg-surface px-4 py-3 text-on-surface">
      <p role={failed ? "alert" : "status"} className="text-sm">
        {deletionRecoveryError ? "Could not check unfinished cleanup on this device. Retry to check and finish cleanup." : <>
          Your account was permanently deleted.
          {completion?.state === "complete" ? " This device is signed out. This account’s chat history was cleared and its stored AI keys were removed." : completion?.state === "cleaning" ? " Finishing cleanup on this device…" : " Cleanup on this device did not finish. Retry to finish signing out and clearing this account’s chat history and stored AI keys."}
        </>}
      </p>
      {failed ? <Button variant="text" onClick={() => void retryDeletionCleanup()}>Retry cleanup</Button> : null}
      {!failed && completion?.state === "complete" ? <Button variant="text" onClick={dismissDeletionCompletion}>Dismiss</Button> : null}
    </section>
  );
}
