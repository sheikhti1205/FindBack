// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({user:null as {id:string} | null,booting:false,bootError:null}));
vi.mock("../auth", () => ({useAuth: () => auth}));
import { SharedReport } from "./SharedReport";
import { getPendingReportRoute } from "../utils/pendingReportLink";
const id = "5b6f7c8d-1234-4abc-8def-123456789012";
function Destination() { const l=useLocation(); return <output>{l.pathname}{l.search}{l.hash}</output>; }
function renderLink(path=`/shared/${id}`) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/shared/:id" element={<SharedReport />} /><Route path="/posts/:id" element={<Destination />} /></Routes></MemoryRouter>);
}
beforeEach(() => { auth.user=null; sessionStorage.clear(); vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "https://findbackapp.social"); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
describe("public shared-report gate", () => {
  it("reveals no report data and retains the destination while signed out", () => {
    renderLink();
    expect(screen.getByRole("heading", {name:"A FindBack report was shared with you."})).toBeTruthy();
    expect(screen.getByRole("link", {name:"Sign in to view"}).getAttribute("href")).toBe("/signin");
    expect(screen.queryByRole("article")).toBeNull();
    expect(getPendingReportRoute()).toBe(`/posts/${id}`);
  });
  it("opens the existing authenticated report route with comment focus", async () => {
    auth.user={id:"u1"};
    renderLink(`/shared/${id}?focus=comments&comment=${id}`);
    expect((await screen.findByRole("status")).textContent).toBe(`/posts/${id}?comment=${id}#detail-comments`);
  });
  it("rejects invalid IDs instead of opening a report", () => {
    renderLink("/shared/invalid");
    expect(screen.getByRole("heading", {name:"Invalid report link"})).toBeTruthy();
    expect(getPendingReportRoute()).toBeNull();
  });
  it("renders the invalid-link state in the designed surface shell, not bare markup", () => {
    const {container} = renderLink("/shared/invalid");
    const main = container.querySelector("main")!;
    for (const token of ["bg-surface", "text-on-surface"]) {
      expect(main.className.split(/\s+/)).toContain(token);
    }
    const back = screen.getByRole("link", {name: "Back to FindBack"});
    expect(back.getAttribute("href")).toBe("/");
    expect(back.className.split(/\s+/)).toContain("bg-on-surface");
  });
});
