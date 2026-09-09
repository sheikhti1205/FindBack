import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Search, PlusCircle, UserRound } from "lucide-react";
import { apiFetch } from "./services/api";

interface Health {
  ok: boolean;
  service: string;
}

/**
 * Phase-1 placeholder shell: proves the toolchain (React + Tailwind tokens +
 * Framer Motion) and live connectivity to the FindBack API. Screens are built
 * feature-by-feature in later phases.
 */
export function App() {
  const [api, setApi] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Health>("/health")
      .then((h) => {
        if (!cancelled) setApi(h);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-surface text-on-surface">
      <header className="flex items-center justify-between border-b border-outline-variant px-4 py-3">
        <span className="text-lg font-semibold tracking-tight">FindBack</span>
        <div className="flex items-center gap-4 text-on-surface-variant">
          <Search size={20} aria-label="Search" />
          <PlusCircle size={20} aria-label="Report" />
          <UserRound size={20} aria-label="Profile" />
        </div>
      </header>

      <motion.main
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <h1 className="text-2xl font-semibold tracking-tight">
          Lost &amp; found, reunited.
        </h1>
        <p className="max-w-xs text-sm text-on-surface-variant">
          Report lost or found items on campus, search the board and recover what
          belongs to you.
        </p>

        <div
          className={`mt-6 rounded-full border px-4 py-1.5 text-xs ${
            error
              ? "border-error text-error"
              : api
                ? "border-outline-variant text-on-surface-variant"
                : "border-outline-variant text-on-surface-variant"
          }`}
        >
          {error
            ? `API unreachable — ${error}`
            : api
              ? `${api.service} connected`
              : "Connecting to API…"}
        </div>
      </motion.main>
    </div>
  );
}
