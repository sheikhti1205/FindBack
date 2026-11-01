import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fetchMyRoleOffer,acceptRoleOffer} from './roles';
const f=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('./supabaseClient',()=>({getSupabase:()=>f}));
const token='bootstrap:00000000-0000-4000-8000-00000000f801';
beforeEach(()=>f.rpc.mockReset());
describe('explicit role offer transport',()=>{
 it('reads a caller-only offer without invoking any mutation',async()=>{
  f.rpc.mockResolvedValue({data:{token,role:'ADMIN',capabilities:['roles_manage']},error:null});
  expect(await fetchMyRoleOffer()).toEqual({token,role:'ADMIN',capabilities:['roles_manage']});
  expect(f.rpc.mock.calls).toEqual([['findback_my_role_offer',{}]]);
 });
 it('treats a null offer as ordinary, not an implied role',async()=>{
  f.rpc.mockResolvedValue({data:null,error:null});expect(await fetchMyRoleOffer()).toBeNull();
 });
 it.each([
  {token,role:'OWNER',capabilities:[]},
  {token:'anything',role:'ADMIN',capabilities:[]},
  {token,role:'MODERATOR',capabilities:['roles_manage']},
  {token,role:'MODERATOR',capabilities:['unknown_power']},
  {token,role:'MODERATOR',capabilities:null},
 ])('refuses a role/scope/token it cannot truthfully present (%j)',async data=>{
  f.rpc.mockResolvedValue({data,error:null});await expect(fetchMyRoleOffer()).rejects.toThrow('Could not check your role offer.');
 });
 it('acceptance is an explicit RPC carrying the exact displayed token',async()=>{
  f.rpc.mockResolvedValue({data:true,error:null});await acceptRoleOffer(token);
  expect(f.rpc.mock.calls).toEqual([['findback_accept_role_offer',{p_token:token}]]);
 });
 it.each([{data:false,error:null},{data:null,error:{message:'secret SQL diagnostic',code:'42501'}}])('never claims acceptance from an error/false response',async result=>{
  f.rpc.mockResolvedValue(result);await expect(acceptRoleOffer(token)).rejects.toThrow('Could not accept this role offer.');
 });
});
