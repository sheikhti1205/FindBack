import { useEffect, useState } from "react";

const EVENT = "findback:announce";

/** Announce a meaningful event to screen readers (and any visible toast host). */
export function announce(message: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: message }));
}

/** Polite live region. Mount once (in Shell) — screens announce via `announce()`. */
export function LiveRegion() {
  const [message, setMessage] = useState("");

  useEffect(() => {
    const handler = (e: Event) => setMessage((e as CustomEvent<string>).detail ?? "");
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  return (
    <div aria-live="polite" role="status" className="sr-only">
      {message}
    </div>
  );
}
