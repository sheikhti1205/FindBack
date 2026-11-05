import { beforeEach, describe, expect, it, vi } from "vitest";
const platform=vi.hoisted(()=>({native:true,names:[] as string[],identity:{} as unknown}));
vi.mock("@capacitor/core",()=>({Capacitor:{isNativePlatform:()=>platform.native},registerPlugin:(name:string)=>{
  platform.names.push(name);return{getIdentity:async()=>platform.identity};
}}));
vi.mock("../buildInfo",()=>({readBuildInfo:async()=>({versionCode:999})}));
import { readInstalledIdentity } from "./runtime";
beforeEach(()=>{platform.identity={};platform.native=true;});
describe("canonical updater identity",()=>{
  it("uses the dedicated Norfold bridge and never guesses missing native version facts",async()=>{
    platform.identity={packageName:"com.findback.app",signingChannel:"beta",abi:"arm64-v8a",sdk:36};
    expect(await readInstalledIdentity()).toBeNull();
    expect(platform.names).toContain("NorfoldAppUpdate");
    expect(platform.names).not.toContain("FindBackUpdateIdentity");
  });
  it("requires a numeric integer and retains only complete installed identity",async()=>{
    platform.identity={packageName:"com.findback.app",versionCode:"123junk",signingChannel:"beta",abi:"arm64-v8a",sdk:36};
    expect(await readInstalledIdentity()).toBeNull();
    platform.identity={packageName:"com.findback.app",versionCode:123,signingChannel:"beta",abi:"arm64-v8a",sdk:36};
    expect(await readInstalledIdentity()).toEqual(platform.identity);
    platform.native=false;expect(await readInstalledIdentity()).toBeNull();
  });
});
