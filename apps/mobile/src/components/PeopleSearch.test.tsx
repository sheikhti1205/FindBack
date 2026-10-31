// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PeopleSearchPage } from "../services/people";
const state = vi.hoisted(() => ({ account:"viewer", search:vi.fn(), chatAccount:"viewer", projections:null as Record<string, unknown> | null }));
vi.mock("../auth", () => ({useAuth:()=>({user:{id:state.account}})}));
vi.mock("../services/messaging/useMessaging", () => ({ useMessaging: () => ({ accountId:state.chatAccount, currentProjections:state.projections }) }));
vi.mock("../services/people",async original=>({...await original<typeof import("../services/people")>(),searchPeople:(...args:unknown[])=>state.search(...args)}));
import { PeopleSearch } from "./PeopleSearch";
const river={id:"peer",username:"river",displayName:"River Lee",avatarUrl:null};
const cursor={query:"river",rank:1,username:"river",id:"peer"};
const view=(query:string)=><MemoryRouter><PeopleSearch query={query}/></MemoryRouter>;
async function tick(){await act(async()=>{vi.advanceTimersByTime(250);});}
beforeEach(()=>{vi.useFakeTimers();state.account="viewer";state.chatAccount="viewer";state.projections=null;state.search.mockReset().mockResolvedValue({items:[river],nextCursor:null});});
afterEach(()=>{cleanup();vi.useRealTimers();});
it("does not search empty input and debounces before showing public-profile rows",async()=>{
  const mount=render(view(" @ "));await tick();expect(state.search).not.toHaveBeenCalled();
  mount.rerender(view(" @River "));expect(state.search).not.toHaveBeenCalled();await tick();
  expect(screen.getByRole("link",{name:/River Lee @river/}).getAttribute("href")).toBe("/u/river");
  expect(screen.queryByRole("button",{name:"Connect"})).toBeNull();
});
it("aborts stale queries and never paints a response that ignores abort",async()=>{
  let resolve!:(page:PeopleSearchPage)=>void;
  state.search.mockReturnValueOnce(new Promise<PeopleSearchPage>(done=>{resolve=done;}));
  const mount=render(view("river"));await tick();const signal=state.search.mock.calls[0]?.[1].signal as AbortSignal;
  mount.rerender(view("other"));expect(signal.aborted).toBe(true);
  await act(async()=>{resolve({items:[river],nextCursor:null});});
  expect(screen.queryByRole("link",{name:/River Lee/})).toBeNull();
});
it("replaces the search lifetime and removes prior-account rows synchronously",async()=>{
  const mount=render(view("river"));await tick();expect(screen.getByText("@river")).toBeTruthy();
  const signal=state.search.mock.calls[0]?.[1].signal as AbortSignal;
  state.account="replacement";mount.rerender(view("river"));
  expect(screen.queryByText("@river")).toBeNull();expect(signal.aborted).toBe(true);
});
it("appends bounded cursor pages without duplicate rows or losing earlier results",async()=>{
  state.search.mockResolvedValueOnce({items:[river],nextCursor:cursor})
    .mockResolvedValueOnce({items:[river,{...river,id:"other",username:"riverbank"}],nextCursor:null});
  render(view("river"));await tick();fireEvent.click(screen.getByRole("button",{name:"Load more people"}));
  await act(async()=>{});
  expect(screen.getAllByRole("link")).toHaveLength(2);
  expect(state.search.mock.calls[1]?.[1].cursor).toEqual(cursor);
  expect(screen.queryByRole("button",{name:"Load more people"})).toBeNull();
});
it("offers a truthful retry after failure and announces an empty result",async()=>{
  state.search.mockRejectedValueOnce(new Error("private backend error")).mockResolvedValueOnce({items:[],nextCursor:null});
  render(view("river"));await tick();expect(screen.getByRole("alert").textContent).not.toContain("private backend");
  fireEvent.click(screen.getByRole("button",{name:"Try again"}));await act(async()=>{});
  expect(screen.getByRole("status").textContent).toMatch(/no people found/i);
});
it("shows viewer-authorized relationship state without exposing the counterpart's private decisions",async()=>{
  state.projections={chat:{peerId:"peer",mode:"REQUEST",request:"OUTGOING",ownBlocked:false}};
  const mount=render(view("river"));await tick();expect(screen.getByText("Request sent")).toBeTruthy();
  state.projections={chat:{peerId:"peer",mode:"CONNECTED",request:"NONE",ownBlocked:false}};
  mount.rerender(view("river"));expect(screen.getByText("Connected")).toBeTruthy();
  state.chatAccount="other";mount.rerender(view("river"));expect(screen.queryByText("Connected")).toBeNull();
});
