import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ rpc: vi.fn(), abort: vi.fn(), response: { data: null as unknown, error: null as unknown } }));
vi.mock("./supabaseClient", () => ({ getSupabase: () => ({ rpc: state.rpc }) }));
import { normalizePeopleQuery, searchPeople } from "./people";
beforeEach(() => {
  state.response = { data: { items: [], nextCursor: null }, error: null };
  state.rpc.mockReset().mockImplementation(() => {
    const result=Promise.resolve(state.response);
    return Object.assign(result,{abortSignal: state.abort.mockImplementation(() => result)});
  });
  state.abort.mockClear();
});
it("normalizes spaces, case and exactly one optional leading @", () => {
  expect(normalizePeopleQuery(" @RiVeR ")).toBe("river");
  expect(normalizePeopleQuery(" @@River ")).toBe("@river");
});
it("does not call the network for empty queries or pre-aborted work", async () => {
  await expect(searchPeople(" @ ")).resolves.toEqual({ items: [], nextCursor: null });
  const abort=new AbortController();abort.abort();
  await expect(searchPeople("river",{signal:abort.signal})).rejects.toHaveProperty("name","AbortError");
  expect(state.rpc).not.toHaveBeenCalled();
});
it("passes normalized query, capped page and cancellation to the RPC", async () => {
  const controller=new AbortController();
  await searchPeople(" @River ",{limit:999,signal:controller.signal});
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith("findback_search_people",{p_query:"river",p_cursor:null,p_limit:30});
  expect(state.abort).toHaveBeenCalledWith(controller.signal);
});
it("maps public fields only, without carrying unknown server fields", async () => {
  const cursor={query:"river",rank:1,username:"riverbank",id:"peer"};
  state.response.data={items:[{id:"peer",username:"riverbank",display_name:"River Bank",avatar_url:null,email:"private@example.test",sanction:"private"}],nextCursor:cursor};
  expect(await searchPeople("river")).toEqual({items:[{id:"peer",username:"riverbank",displayName:"River Bank",avatarUrl:null}],nextCursor:cursor});
});
it("continues a cursor without changing its query context", async () => {
  const cursor={query:"river",rank:1,username:"riverbank",id:"peer"};
  await searchPeople("river",{cursor});
  expect(state.rpc.mock.calls[0]?.[1].p_cursor).toEqual(cursor);
  await expect(searchPeople("other",{cursor})).rejects.toThrow();
});
it("refuses invalid pages and cursor responses rather than treating them as an empty success", async () => {
  state.response.data={items:[{email:"private@example.test"}],nextCursor:null};
  await expect(searchPeople("river")).rejects.toThrow();
  state.response.data={items:[],nextCursor:{query:"other",rank:0,username:"river",id:"peer"}};
  await expect(searchPeople("river")).rejects.toThrow();
});
it("propagates server refusal and rejects oversized search input", async () => {
  state.response.error={message:"not authorized",code:"42501"};
  await expect(searchPeople("river")).rejects.toThrow();
  await expect(searchPeople("r".repeat(81))).rejects.toThrow();
});
it("discards a response that resolves after cancellation", async () => {
  let resolve!:(value:{data:unknown;error:null})=>void;
  const result=new Promise<{data:unknown;error:null}>(done=>{resolve=done;});
  state.rpc.mockReturnValue(Object.assign(result,{abortSignal:()=>result}));
  const controller=new AbortController();const request=searchPeople("river",{signal:controller.signal});
  controller.abort();resolve({data:{items:[],nextCursor:null},error:null});
  await expect(request).rejects.toHaveProperty("name","AbortError");
});
