// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportSharingSettings } from "./ReportSharingSettings";
const f=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock("../services/supabaseClient",()=>({getSupabase:()=>({rpc:f.rpc})}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe("owner public preview control",()=>{
 it("does not claim a failed initial read is off or allow an unknown-state write",async()=>{
  f.rpc.mockRejectedValue(new Error("private diagnostic"));
  render(<ReportSharingSettings postId="one"/>);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByRole("checkbox",{name:"Public link preview"}) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).not.toMatch(/preview is off/i);
  expect(document.body.textContent).not.toContain("private diagnostic");
 });
 it("reads server preference then revokes without disabling full signed-in report visibility",async()=>{
  let enabled=true;f.rpc.mockImplementation(async(_name,args)=>{if(args.p_enabled!==null)enabled=args.p_enabled;return {data:enabled,error:null};});
  render(<ReportSharingSettings postId="one"/>);
  const toggle=await screen.findByRole("checkbox",{name:"Public link preview"});
  await waitFor(()=>expect((toggle as HTMLInputElement).checked).toBe(true));
  fireEvent.click(toggle);await waitFor(()=>expect((toggle as HTMLInputElement).checked).toBe(false));
  expect(enabled).toBe(false);expect(f.rpc).toHaveBeenLastCalledWith("findback_report_sharing",{p_post_id:"one",p_enabled:false});
  expect(screen.getByRole("status").textContent).toMatch(/preview is off/i);
 });
 it("failed change keeps the last server state, announces failure and offers retry",async()=>{
  f.rpc.mockResolvedValueOnce({data:true,error:null}).mockResolvedValue({data:null,error:{message:"private diagnostic"}});
  render(<ReportSharingSettings postId="one"/>);const toggle=await screen.findByRole("checkbox",{name:"Public link preview"});
  await waitFor(()=>expect((toggle as HTMLInputElement).checked).toBe(true));fireEvent.click(toggle);
  expect(await screen.findByRole("alert")).toBeTruthy();expect((toggle as HTMLInputElement).checked).toBe(true);
  expect(document.body.textContent).not.toContain("private diagnostic");
 });
 it("ignores a late old-report read after identity changes",async()=>{
  let finish!:(v:unknown)=>void;f.rpc.mockImplementationOnce(()=>new Promise(r=>{finish=r;})).mockResolvedValue({data:false,error:null});
  const v=render(<ReportSharingSettings postId="one"/>);v.rerender(<ReportSharingSettings postId="two"/>);
  await waitFor(()=>expect((screen.getByRole("checkbox",{name:"Public link preview"}) as HTMLInputElement).disabled).toBe(false));
  await act(async()=>finish({data:true,error:null}));expect((screen.getByRole("checkbox",{name:"Public link preview"}) as HTMLInputElement).checked).toBe(false);
 });
});
