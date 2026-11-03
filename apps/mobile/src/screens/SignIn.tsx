import { AuthGateway } from "./AuthGateway";
import { useLocation } from "react-router";
import { readRememberedAccounts } from "../services/rememberedAccounts";

/**
 * Compat entry: `/signin` maps to the auth gateway in sign-in mode.
 * Renderable standalone; the lead integrator may rewire this route to
 * `<AuthGateway initialMode="signin" />` directly.
 */
export function SignIn({ email }: { email?: string }) {
  const location = useLocation();
  const id = (location.state as { rememberedAccountId?: unknown } | null)?.rememberedAccountId;
  const remembered = typeof id === "string" ? readRememberedAccounts().find(account => account.id === id) : undefined;
  return <AuthGateway initialMode="signin" initialEmail={email ?? remembered?.loginEmail ?? ""} />;
}
