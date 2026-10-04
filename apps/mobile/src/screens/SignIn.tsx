import { AuthGateway } from "./AuthGateway";

/**
 * Compat entry: `/signin` maps to the auth gateway in sign-in mode.
 * Renderable standalone; the lead integrator may rewire this route to
 * `<AuthGateway initialMode="signin" />` directly.
 */
export function SignIn({ email }: { email?: string }) {
  return <AuthGateway initialMode="signin" initialEmail={email ?? ""} />;
}
