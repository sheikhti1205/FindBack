import { motion } from "framer-motion";
import { Navigate } from "react-router";
import { useAuth } from "../auth";

/** Boot screen: shows briefly while a stored session hydrates, then redirects. */
export function Splash() {
  const { user, booting } = useAuth();
  if (booting) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-surface text-on-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
          className="flex h-16 w-16 items-center justify-center rounded-m3-lg bg-on-surface text-2xl font-bold text-surface"
          aria-hidden
        >
          F
        </motion.div>
        <p className="text-sm text-on-surface-variant">FindBack</p>
      </div>
    );
  }
  return <Navigate to={user ? "/" : "/signin"} replace />;
}
