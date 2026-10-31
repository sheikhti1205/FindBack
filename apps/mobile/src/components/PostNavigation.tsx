import { createContext, useContext } from "react";
import { Link, useLocation, useNavigate, type LinkProps, type Location } from "react-router";

/** UI navigation only; the auth provider and route guards remain authoritative. */
const PostNavigationContext = createContext<string | null>(null);
export const PostNavigationProvider = PostNavigationContext.Provider;

function isBackgroundPath(path: string): boolean {
  return ["/", "/search", "/my", "/saved", "/notifications"].includes(path) || /^\/u\/[A-Za-z0-9_]+$/.test(path);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** History state is untrusted, and may belong to a previous signed-in account. */
export function postBackgroundLocation(location: Location, viewerId: string | null): Location | null {
  if (!viewerId || !/^\/posts\/[^/]+$/.test(location.pathname) || !record(location.state)) return null;
  const background = location.state.postBackground;
  if (!record(background) || background.viewerId !== viewerId || !record(background.location)) return null;
  const source = background.location;
  if (typeof source.pathname !== "string" || !isBackgroundPath(source.pathname) ||
    typeof source.search !== "string" || typeof source.hash !== "string" || typeof source.key !== "string") return null;
  return source as unknown as Location;
}

/** Normal links/new tabs remain real report URLs; only same-tab wide navigation is contextual. */
export function PostLink({ onClick, ...props }: LinkProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const viewerId = useContext(PostNavigationContext);
  return <Link {...props} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
      props.reloadDocument || props.download || (props.target && props.target !== "_self") || !viewerId || window.innerWidth < 768) return;
    const background = postBackgroundLocation(location, viewerId) ?? (isBackgroundPath(location.pathname) ? location : null);
    if (!background) return;
    event.preventDefault();
    void navigate(props.to, { replace: props.replace, relative: props.relative, preventScrollReset: true,
      state: { ...(record(props.state) ? props.state : {}), postBackground: { location: background, viewerId } },
    });
  }} />;
}
