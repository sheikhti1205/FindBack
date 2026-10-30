import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../services/session";
import { useSafetyLifetime } from "./useSafetyLifetime";

/** Inside an account/target-keyed surface only. Retains confirmed content during
 * read-only refresh; generations fence late reads and permission loss clears it. */
export function useSafetyResource<T>(fetchValue: () => Promise<T>) {
  const alive = useSafetyLifetime();
  const generation = useRef(0);
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const clear = useCallback(() => { generation.current++; setValue(null); }, []);
  const refresh = useCallback(async () => {
    const run = ++generation.current;
    setLoading(true); setError(null);
    try {
      const next = await fetchValue();
      if (alive.current && run === generation.current) { setValue(next); return true; }
      return false;
    } catch (err) {
      if (alive.current && run === generation.current) {
        setError(err);
        if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) setValue(null);
      }
      return false;
    } finally {
      if (alive.current && run === generation.current) setLoading(false);
    }
  }, [fetchValue, alive]);
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  return { value, error, loading, refresh, clear };
}

/** Append raw keyset pages, including filtered-empty pages. A new filter/account
 * must remount this hook rather than carry the previous queue into its scope. */
export function useSafetyPages<T, C>(fetchPage: (before?: C) => Promise<{ items: T[]; nextCursor: C | null }>) {
  const alive = useSafetyLifetime();
  const generation = useRef(0);
  const pending = useRef(false);
  const [items, setItems] = useState<T[] | null>(null);
  const [cursor, setCursor] = useState<C | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (before?: C) => {
    if (pending.current) return;
    pending.current = true;
    const run = ++generation.current;
    setLoading(true); setError(null);
    try {
      const page = await fetchPage(before);
      if (!alive.current || run !== generation.current) return;
      setItems(previous => before ? [...(previous ?? []), ...page.items] : page.items);
      setCursor(page.nextCursor);
    } catch (err) {
      if (alive.current && run === generation.current) {
        setError(err);
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) { setItems(null); setCursor(null); }
      }
    } finally {
      if (run === generation.current) {
        pending.current = false;
        if (alive.current) setLoading(false);
      }
    }
  }, [fetchPage, alive]);
  useEffect(() => { void load(); return () => { generation.current++; pending.current = false; }; }, [load]);
  return { items, error, loading, cursor, refresh: () => load(), more: () => cursor ? load(cursor) : Promise.resolve() };
}
