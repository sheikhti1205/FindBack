import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { SearchedProfile } from "@findback/shared";
import { UserQuickCard } from "./UserQuickCard";

export type PublicIdentity = Pick<SearchedProfile, "id" | "username"> & Partial<Pick<SearchedProfile, "displayName" | "avatarUrl">>;
const IdentityActions = createContext<ComponentType<{ person: PublicIdentity }> | null>(null);

/** Shell supplies the account-fenced feature owner; shared anatomy stays a
 * public-only view and can render without auth/runtime providers in previews. */
export function UserIdentityProvider({ actions, children }: { actions: ComponentType<{ person: PublicIdentity }>; children: ReactNode }) {
  return <IdentityActions.Provider value={actions}>{children}</IdentityActions.Provider>;
}

export function UserIdentityTrigger({ person, trigger }: { person: PublicIdentity; trigger?: ReactNode }) {
  const Actions = useContext(IdentityActions);
  return <UserQuickCard username={person.username} displayName={person.displayName} avatarUrl={person.avatarUrl} trigger={trigger}
    actions={Actions && <Actions person={person} />} />;
}
