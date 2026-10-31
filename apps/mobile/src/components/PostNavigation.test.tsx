// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostLink, PostNavigationProvider, postBackgroundLocation } from "./PostNavigation";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Destination() {
  const location = useLocation();
  return <output data-testid="destination">{JSON.stringify(location)}</output>;
}
function setup(viewerId: string | null = "reader", props = {}) {
  render(<MemoryRouter initialEntries={["/search?q=wallet"]}><PostNavigationProvider value={viewerId}>
    <PostLink to="/posts/p1#detail-comments" {...props}>Open report</PostLink>
    <Destination />
  </PostNavigationProvider></MemoryRouter>);
}
function destination() { return JSON.parse(screen.getByTestId("destination").textContent!); }

describe("contextual report navigation", () => {
  it("decides at activation time, preserving phone routes and wide-screen context after resize", () => {
    vi.stubGlobal("innerWidth", 393);
    setup();
    vi.stubGlobal("innerWidth", 1024);
    fireEvent.click(screen.getByRole("link", { name: "Open report" }));
    expect(destination()).toMatchObject({ pathname: "/posts/p1", hash: "#detail-comments", state: {
      postBackground: { viewerId: "reader", location: { pathname: "/search", search: "?q=wallet" } },
    } });
  });

  it.each([[393, "reader"], [1024, null]] as const)("uses ordinary standalone navigation at %ipx for %s", (width, viewerId) => {
    vi.stubGlobal("innerWidth", width);
    setup(viewerId);
    const link = screen.getByRole("link", { name: "Open report" });
    expect(link.getAttribute("href")).toBe("/posts/p1#detail-comments");
    fireEvent.click(link);
    expect(destination()).toMatchObject({ pathname: "/posts/p1", hash: "#detail-comments", state: null });
  });

  it("honors a caller-cancelled navigation", () => {
    vi.stubGlobal("innerWidth", 1024);
    setup("reader", { onClick: (event: React.MouseEvent) => event.preventDefault() });
    fireEvent.click(screen.getByRole("link", { name: "Open report" }));
    expect(destination().pathname).toBe("/search");
  });

  it("rejects malformed, recursive, external and different-account history backgrounds", () => {
    const base = { pathname: "/posts/p1", search: "", hash: "", key: "current", state: null as unknown };
    for (const location of [null, "https://example.test", { pathname: "//example.test", search: "", hash: "", key: "x" },
      { pathname: "/posts/p2", search: "", hash: "", key: "x" }, { pathname: "/", search: 12, hash: "", key: "x" }]) {
      expect(postBackgroundLocation({ ...base, state: { postBackground: { viewerId: "reader", location } } }, "reader")).toBeNull();
    }
    expect(postBackgroundLocation({ ...base, state: { postBackground: { viewerId: "old-account", location: {
      pathname: "/search", search: "", hash: "", key: "source", state: null,
    } } } }, "reader")).toBeNull();
  });
});
