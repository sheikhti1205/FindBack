// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readAuthSessionId } from "./authSessionIdentity";
const account="00000000-0000-4000-8000-000000000001", sessionId="00000000-0000-4000-8000-000000000011";
const token=(payload: unknown)=>`e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c3ludGhldGlj`;
describe("SDK session routing identity, never an authentication verifier",()=>{
  it("keeps one lifetime across token refresh and distinguishes same-account replacement",()=>{
    expect(readAuthSessionId({user:{id:account},access_token:token({sub:account,session_id:sessionId,exp:100})})).toBe(sessionId);
    expect(readAuthSessionId({user:{id:account},access_token:token({sub:account,session_id:sessionId,exp:200})})).toBe(sessionId);
    expect(readAuthSessionId({user:{id:account},access_token:token({sub:account,session_id:account})})).toBe(account);
  });
  it.each([null,{},[],{sub:account},{sub:sessionId,session_id:sessionId},{sub:account,session_id:[]},
    {sub:account,session_id:"invalid"}])("rejects absent or mismatched claims %j",claims=>{
    expect(readAuthSessionId({user:{id:account},access_token:token(claims)})).toBeNull();
  });
  it("fails closed without throwing or returning bearer material",()=>{
    expect(readAuthSessionId(null)).toBeNull();
    for(const access_token of ["bad","e30.invalid!.sig","e30."+"a".repeat(32768)+".sig"]){
      expect(readAuthSessionId({user:{id:account},access_token})).toBeNull();
    }
  });
});
