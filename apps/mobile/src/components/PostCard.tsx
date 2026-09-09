import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router";

interface PostCardProps {
  children: ReactNode;
  to: string;
  index?: number;
}

export function PostCard({ children, to, index = 0 }: PostCardProps) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index * 0.03, 0.3) }}
    >
      <Link
        to={to}
        className="flex flex-col gap-2 rounded-m3-md border border-outline-variant bg-surface-container-low p-4 transition-colors hover:border-on-surface-variant active:bg-surface-container"
      >
        {children}
      </Link>
    </motion.article>
  );
}

export function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-on-surface-variant">{icon}</div>}
      <h2 className="text-base font-semibold text-on-surface">{title}</h2>
      {subtitle && <p className="max-w-xs text-sm text-on-surface-variant">{subtitle}</p>}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-on-surface-variant" role="status">
      <span
        aria-hidden
        className="h-6 w-6 animate-spin rounded-full border-2 border-outline border-t-on-surface"
      />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-outline px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
      {status}
    </span>
  );
}
