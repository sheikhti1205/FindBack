// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({user:null as {id:string} | null,booting:false,bootError:null}));
vi.mock("../auth", () => ({useAuth: () => auth}));
const data=vi.hoisted(()=>({get:vi.fn()}));
vi.mock("../services/sharedPreview",async importOriginal=>({...await importOriginal<typeof import("../services/sharedPreview")>(),getSharedPreview:data.get}));
import { SharedReport } from "./SharedReport";
import { getPendingReportRoute } from "../utils/pendingReportLink";
const id = "5b6f7c8d-1234-4abc-8def-123456789012";
function Destination() { const l=useLocation(); return <output>{l.pathname}{l.search}{l.hash}</output>; }
function renderLink(path=`/shared/${id}`) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/shared/:id" element={<SharedReport />} /><Route path="/posts/:id" element={<Destination />} /><Route path="/signin" element={<Destination />} /></Routes></MemoryRouter>);
}
beforeEach(() => { auth.user=null; auth.booting=false; sessionStorage.clear(); data.get.mockReset(); data.get.mockResolvedValue({id,type:"FOUND",title:"Black backpack",category:"Bags & Wallets",event_month:"2026-11",excerpt:"A found item report. Sign in to compare the details and contact the person who posted it."}); vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "https://findbackapp.social"); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
describe("public shared-report gate", () => {
  it("renderer contact CTA enters sign-in with the pending report retained, without anonymous fetch", async () => {
    renderLink(`/shared/${id}?contact=1`);
    expect((await screen.findByRole("status")).textContent).toBe("/signin");
    expect(getPendingReportRoute()).toBe(`/posts/${id}`);
    expect(data.get).not.toHaveBeenCalled();
  });
  it("shows only the safe shared projection and retains destination while signed out", async () => {
    renderLink();
    expect(await screen.findByRole("heading", {name:"Black backpack"})).toBeTruthy();
    expect(screen.getByRole("link", {name:"Sign in to contact"}).getAttribute("href")).toBe("/signin");
    expect(screen.getByRole("article")).toBeTruthy();
    expect(screen.getByText(/November 2026/)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(getPendingReportRoute()).toBe(`/posts/${id}`);
  });
  it("distinguishes unavailable from a retryable connection error without stale report content",async()=>{
    data.get.mockResolvedValueOnce(null);const view=renderLink();
    expect(await screen.findByRole("heading",{name:"This report is no longer available"})).toBeTruthy();view.unmount();
    data.get.mockRejectedValueOnce(new Error("private diagnostic"));renderLink();
    expect(await screen.findByRole("alert")).toBeTruthy();expect(document.body.textContent).not.toContain("private diagnostic");
    fireEvent.click(screen.getByRole("button",{name:"Try again"}));expect(await screen.findByRole("heading",{name:"Black backpack"})).toBeTruthy();
  });
  it("does not publish stale old-report data when a delayed request crosses route identity",async()=>{
    let finish!:(value:unknown)=>void;data.get.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
    const view=renderLink();await waitFor(()=>expect(data.get).toHaveBeenCalled());view.unmount();
    await act(async()=>finish({id,title:"stale",type:"LOST"}));expect(document.body.textContent).not.toContain("stale");
  });
  it("keeps route-arrival keyboard focus on the heading when the loading preview resolves",async()=>{
    let finish!:(value:unknown)=>void;data.get.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
    renderLink();const heading=screen.getByRole("heading",{name:"Shared report"});
    expect(document.activeElement).toBe(heading);
    await act(async()=>finish({id,type:"FOUND",title:"Black backpack",category:"Bags & Wallets",event_month:null,excerpt:"A found item report. Sign in to compare the details and contact the person who posted it."}));
    expect(document.activeElement).toBe(screen.getByRole("heading",{name:"Black backpack"}));
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
