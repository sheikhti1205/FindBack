import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../auth";
import { Button } from "./Button";

type Failure = { userId: string; message: string };
const FeedbackContext = createContext<((failure: Failure) => void) | null>(null);

/** A refused delete must remain visible even after its screen has gone away. */
export function ReportDeletionFeedbackProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [failure, setFailure] = useState<Failure | null>(null);
  const accountRef = useRef(user?.id);
  useEffect(() => {
    accountRef.current = user?.id;
    setFailure(null);
  }, [user?.id]);
  const reportFailure = useCallback((next: Failure) => {
    if (next.userId === accountRef.current) setFailure(next);
  }, []);
  const visible = failure && failure.userId === user?.id ? failure : null;
  return (
    <FeedbackContext.Provider value={reportFailure}>
      {visible && (
        <section aria-label="Report deletion" className="mx-auto w-full max-w-lg border-b border-outline-variant bg-surface px-4 py-3 text-on-surface">
          <p role="alert" className="text-sm">{visible.message}</p>
          <Button variant="text" onClick={() => setFailure(null)}>Dismiss</Button>
        </section>
      )}
      {children}
    </FeedbackContext.Provider>
  );
}

export function useReportDeletionFailure() {
  const reportFailure = useContext(FeedbackContext);
  if (!reportFailure) throw new Error("Report deletion feedback requires its app provider");
  return reportFailure;
}
