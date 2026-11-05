// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { UpdateJob } from "./UpdateJob";
import type { AppUpdateState } from "../services/updates/native";
afterEach(cleanup);
function show(state: AppUpdateState) {
  const actions={install:vi.fn(),cancel:vi.fn(),permission:vi.fn()};
  render(<UpdateJob state={state} onInstall={actions.install} onCancel={actions.cancel} onPermission={actions.permission}/>);
  return actions;
}
describe("explicit Android update job controls",()=>{
  it("reports bounded progress without claiming installation",()=>{
    show({kind:"downloading",releaseId:"test",received:5,total:20,revision:1});
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("5");
    expect(screen.queryByRole("button",{name:"Install update"})).toBeNull();
    expect(screen.getByRole("button",{name:"Cancel download"})).toBeTruthy();
  });
  it("requires separate actions for installation and unknown-source Settings",()=>{
    const actions=show({kind:"needs-permission",releaseId:"test",revision:1});
    expect(actions.permission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"Open Android settings"}));expect(actions.permission).toHaveBeenCalledOnce();
    expect(screen.getByText(/Android asks you to allow updates from Norfold/)).toBeTruthy();
  });
  it.each(["verifying","ready","needs-confirmation","installing","installed","cancelled","failed"] as const)("renders %s with truthful next actions",kind=>{
    show(kind==="failed"?{kind,releaseId:"test",code:"signature",retryable:false,revision:1}:{kind,releaseId:"test",revision:1});
    expect(screen.getByRole("status").textContent).not.toContain("signature");
    if(kind==="ready")expect(screen.getByRole("button",{name:"Install update"})).toBeTruthy();
    if(kind==="needs-confirmation")expect(screen.getByRole("button",{name:"Continue installation"})).toBeTruthy();
    if(kind==="installed")expect(screen.getByText(/This device is running the updated app/)).toBeTruthy();
  });
});
