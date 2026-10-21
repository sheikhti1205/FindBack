/**
 * Primary-navigation layout (owner ruling 4(e)).
 *
 * The reader picks a bottom bar or a side rail in Appearance. That preference
 * is only honoured where a side column can exist: at the compact breakpoint and
 * up. Below it the bottom bar always wins, so a stored `"rail"` can never turn
 * a phone into a narrow column or a drawer.
 *
 * The width gate is `useWideViewport` (the single owner of the rail breakpoint,
 * derived from `COMPACT_MAX_PX` in `responsive.ts`); this module only decides
 * how the stored preference resolves against it. One resolver, no second media
 * query, no parallel nav system.
 */
import { useAppearance, type NavLayout } from "../appearance";
import { useWideViewport } from "./responsive";

/** What the stored preference renders as at this viewport width. */
export function resolveNavLayout(
  preference: NavLayout,
  wideViewport: boolean,
): NavLayout {
  return preference === "rail" && wideViewport ? "rail" : "bottom";
}

/** The layout the shell should render right now. */
export function useNavLayout(): NavLayout {
  const { settings } = useAppearance();
  const wideViewport = useWideViewport();
  return resolveNavLayout(settings.navLayout, wideViewport);
}
