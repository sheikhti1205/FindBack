// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";

const native = vi.hoisted(() => ({ enabled: true, launch: undefined as string | undefined, listener: null as ((event: {url:string}) => void) | null, removed: false }));
const auth = vi.hoisted(() => ({ user: null as {id:string} | null, booting: false }));
vi.mock("../auth", () => ({ useAuth: () => auth }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => native.enabled } }));
vi.mock("@capacitor/app", () => ({ App: {
  getLaunchUrl: async () => native.launch ? {url:native.launch} : undefined,
  addListener: async (_event: string, cb: (event: {url:string}) => void) => { native.listener = cb; return {remove: () => { native.removed = true; }}; },
} }));
import { ReportLinkHandler } from "./ReportLinkHandler";
import { getPendingReportRoute } from "../utils/pendingReportLink";

const origin = "https://findbackapp.social";
const id = "5b6f7c8d-1234-4abc-8def-123456789012";
function Location() { const l = useLocation(); return <output>{l.pathname}{l.search}{l.hash}</output>; }
function Harness() { return <MemoryRouter><ReportLinkHandler /><Location /></MemoryRouter>; }
beforeEach(() => { vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", origin); auth.user = null; auth.booting = false; native.enabled = true; native.launch = undefined; native.listener = null; native.removed = false; sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); window.history.replaceState(null, "", "/"); });

describe("App Link navigation", () => {
  it("holds a cold signed-out link through authentication then consumes it once", async () => {
    native.launch = `${origin}/r/${id}?focus=comments&comment=${id}`;
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(`/shared/${id}?focus=comments&comment=${id}`));
    expect(getPendingReportRoute()).toBe(`/posts/${id}?comment=${id}#detail-comments`);
    auth.user = {id:"u1"};
    view.rerender(<Harness />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(`/posts/${id}?comment=${id}#detail-comments`));
    expect(getPendingReportRoute()).toBeNull();
  });
  it("opens warm links and ignores hostile URLs", async () => {
    auth.user = {id:"u1"};
    render(<Harness />);
    await waitFor(() => expect(native.listener).not.toBeNull());
    act(() => native.listener?.({url:`https://evil.test/r/${id}`}));
    expect(screen.getByRole("status").textContent).toBe("/");
    act(() => native.listener?.({url:`${origin}/r/${id}`}));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(`/posts/${id}`));
  });
  it("cleans up its native listener", async () => {
    const view = render(<Harness />);
    await waitFor(() => expect(native.listener).not.toBeNull());
    view.unmount();
    expect(native.removed).toBe(true);
  });
  it("maps a browser /r URL to an account-gated shared screen", async () => {
    native.enabled = false;
    window.history.replaceState(null, "", `/r/${id}`);
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(`/shared/${id}`));
  });
  it("does not resume an expired link or a tampered stored route", () => {
    sessionStorage.setItem("findback.pendingReportLink", JSON.stringify({url:`${origin}/r/${id}`, expiresAt:Date.now()-1}));
    expect(getPendingReportRoute()).toBeNull();
    sessionStorage.setItem("findback.pendingReportLink", JSON.stringify({url:"https://evil.test",expiresAt:Date.now()+1000}));
    expect(getPendingReportRoute()).toBeNull();
  });
});
