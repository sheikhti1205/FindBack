import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

/**
 * useState persisted to a URL search param (WP7 #7).
 *
 * The param is the shareable source of truth: back-nav from a detail page,
 * deep-links, and copied links all restore the filter on mount. Edits replace
 * the current history entry so typing does not spam history. An empty value
 * removes the param to keep links clean.
 */
export function useUrlParam(key: string, initial = ""): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const [value, setValue] = useState(() => params.get(key) ?? initial);

  useEffect(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if ((next.get(key) ?? "") === value) return prev;
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [key, value, setParams]);

  return [value, setValue];
}
