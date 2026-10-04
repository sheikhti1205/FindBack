import { AuthGateway } from "./AuthGateway";

/**
 * Compat entry: `/register` maps to the auth gateway in signup mode.
 * Renderable standalone; the lead integrator may rewire this route to
 * `<AuthGateway initialMode="signup" />` directly. Backend behavior is the
 * shared signup flow (safe duplicate semantics, live username check).
 */
export function Register({ email }: { email?: string }) {
  return <AuthGateway initialMode="signup" initialEmail={email ?? ""} />;
}
