// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { MessagingRuntimeSnapshot } from "../services/messaging/runtime";
const state = vi.hoisted(() => ({ chat: null as unknown as MessagingRuntimeSnapshot }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "viewer" } }) }));
vi.mock("../services/messaging/useMessaging", () => ({ useMessaging: () => state.chat }));
vi.mock("../services/accountLabels", () => ({ fetchAccountLabels: async () => new Map([["peer", "river"], ["requester", "robin"], ["archived", "rowan"]]) }));
vi.mock("../services/people", async original => ({ ...await original<typeof import("../services/people")>(), searchPeople: async () => ({ items: [], nextCursor: null }) }));
vi.mock("../services/posts", () => ({ fetchPost: async () => ({ id:"report", title:"Blue wallet", type:"FOUND" }) }));
import { Connections, LegacyChatsRedirect } from "./Messaging";
import { RouteTransition } from "../components/RouteTransition";
function Location() { return <p data-testid="location">{useLocation().pathname}</p>; }
function app() { return <MemoryRouter initialEntries={["/chats"]}><Routes><Route element={<RouteTransition />}>
  <Route path="/chats" element={<Connections />}><Route path=":conversationId" element={<><Location/><a href="#unused">Thread body</a></>} /></Route>
</Route></Routes></MemoryRouter>; }
beforeEach(() => {
  const views = [
    { conversationId:"chat",peerId:"peer", mode:"CONNECTED" as const,request:"NONE" as const,ownHidden:false },
    { conversationId:"request",peerId:"requester",mode:"REQUEST" as const,request:"INCOMING" as const,ownHidden:false },
    { conversationId:"archive",peerId:"archived",mode:"CONNECTED" as const,request:"NONE" as const,ownHidden:true },
  ].map(v=>({...v,requestEpoch:null,ownBlocked:false,ownDeclined:false,revision:1}));
  state.chat={accountId:"viewer",status:"ready",revision:1,error:null,currentProjections:Object.fromEntries(views.map(v=>[v.conversationId,v])),conversations:views.map(v=>({conversationId:v.conversationId,peerId:v.peerId,cachedProjection:v,lastMessage:null,lastSequence:0,unreadCount:v.conversationId==="request"?2:0,pendingCount:0,updatedAt:0,projectionObservedAt:0}))};
  Object.defineProperty(window,"innerWidth",{value:1200,configurable:true});
});
afterEach(cleanup);
it("uses canonical thread links and retains the actual list/search owner across navigation", async () => {
  render(app());
  const link=await screen.findByRole("link",{name:/@river/});expect(link.getAttribute("href")).toBe("/chats/chat");
  const search=screen.getByRole("searchbox",{name:"Search people or chats"});
  fireEvent.change(search,{target:{value:"river"}});fireEvent.click(link);
  await waitFor(()=>expect(screen.getByTestId("location").textContent).toBe("/chats/chat"));
  expect(screen.getByRole("searchbox",{name:"Search people or chats"})).toBe(search);
  expect(search).toHaveProperty("value","river");
  expect(screen.getAllByTestId("route-transition")).toHaveLength(1);
});
it("counts visible incoming requests and separates archived/unread filters", async () => {
  render(app());await screen.findByRole("link",{name:/@river/});
  fireEvent.click(screen.getByRole("button",{name:"Requests, 1"}));
  expect(screen.getByRole("link",{name:/@robin/})).toBeTruthy();expect(screen.queryByRole("link",{name:/@river/})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Filter chats"}));fireEvent.click(await screen.findByRole("menuitem",{name:"Archived"}));
  expect(screen.getByRole("link",{name:/@rowan/})).toBeTruthy();expect(screen.queryByRole("link",{name:/@robin/})).toBeNull();
});
it.each(["/connections", "/connections/chat"])("replaces legacy %s with the canonical destination and preserves query/hash", async path => {
  function Probe(){const location=useLocation();return <p data-testid="redirect">{location.pathname+location.search+location.hash}</p>;}
  render(<MemoryRouter initialEntries={[`${path}?from=push#message`]}><Routes>
    <Route path="/connections" element={<LegacyChatsRedirect/>}/><Route path="/connections/:conversationId" element={<LegacyChatsRedirect/>}/>
    <Route path="/chats" element={<Probe/>}/><Route path="/chats/:conversationId" element={<Probe/>}/>
  </Routes></MemoryRouter>);
  await waitFor(()=>expect(screen.getByTestId("redirect").textContent).toBe(path.replace("connections","chats")+"?from=push#message"));
});
it("shows readable report context and a truthful local update time on a request row without nested links",async()=>{
  const row=state.chat.conversations.find(v=>v.conversationId==="request")!;
  row.updatedAt=new Date("2026-10-30T10:00:00Z").getTime();
  row.lastMessage={id:"message",conversationId:"request",authorId:"requester",recipientId:"viewer",body:"Is it yours?",messageType:"TEXT",contextReportId:"report"};
  render(app());fireEvent.click(screen.getByRole("button",{name:"Requests, 1"}));
  expect(await screen.findByText(/Blue wallet/)).toBeTruthy();
  const link=screen.getByRole("link",{name:/@robin/});expect(link.querySelector("a")).toBeNull();
  expect(link.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-30T10:00:00.000Z");
});
