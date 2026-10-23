import { useEffect, useRef } from "react";

/** Used inside account/target-keyed safety components. Never publish after unmount. */
export function useSafetyLifetime() {
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  return alive;
}
