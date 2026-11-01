import { afterEach, describe, expect, it, vi } from "vitest";
import { getSharedPreview } from "./sharedPreview";
const id="5b6f7c8d-1234-4abc-8def-123456789012";
const p={id,type:"FOUND",title:"Black backpack",category:"Bags & Wallets",event_month:"2026-11",excerpt:"A found item report. Sign in to compare the details and contact the person who posted it."};
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe("anonymous shared projection transport",()=>{
 it("requests only same-domain public JSON without cookies or auth",async()=>{
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN","https://findbackapp.social");
  const http=vi.fn().mockResolvedValue(new Response(JSON.stringify(p)));vi.stubGlobal("fetch",http);
  expect(await getSharedPreview(id)).toEqual(p);
  expect(http).toHaveBeenCalledWith(`https://findbackapp.social/api/share/${id}?format=json`,expect.objectContaining({credentials:"omit",cache:"no-store"}));
 });
 it("returns null only for unavailable responses; fails visibly for outages and schema drift",async()=>{
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN","https://findbackapp.social");
  for(const [status,body] of [[404,null],[503,null],[200,{...p,author_email:"private"}]] as const){
   vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status})));
   if(status===404)expect(await getSharedPreview(id)).toBeNull();else await expect(getSharedPreview(id)).rejects.toThrow();
  }
 });
});
