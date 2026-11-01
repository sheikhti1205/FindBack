// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {MemoryRouter} from 'react-router';
import {RoleOfferNotice} from './RoleOfferNotice';
const f=vi.hoisted(()=>({user:{id:'one'} as {id:string}|null,read:vi.fn(),accept:vi.fn()}));
vi.mock('../auth',()=>({useAuth:()=>({user:f.user})}));
vi.mock('../services/roles',()=>({fetchMyRoleOffer:()=>f.read(),acceptRoleOffer:(token:string)=>f.accept(token),capabilityLabel:(value:string)=>value==='reports_review'?'Review reports':'Unknown capability'}));
const offer={token:'bootstrap:one',role:'ADMIN',capabilities:[]};
const view=()=> <MemoryRouter><RoleOfferNotice/></MemoryRouter>;
beforeEach(()=>{f.user={id:'one'};f.read.mockReset().mockResolvedValue(offer);f.accept.mockReset().mockResolvedValue(undefined);});
afterEach(cleanup);
describe('informed role acceptance notice',()=>{
 it('shows the offered title after setup but never accepts on mount',async()=>{
  render(view());expect(await screen.findByRole('heading',{name:'Admin access offered'})).toBeTruthy();
  expect(screen.getByText(/only after you accept/i)).toBeTruthy();expect(f.accept).not.toHaveBeenCalled();
 });
 it('shows ordinary accounts no invitation or action',async()=>{
  f.read.mockResolvedValue(null);render(view());await waitFor(()=>expect(f.read).toHaveBeenCalledOnce());expect(screen.queryByRole('button')).toBeNull();
 });
 it('requires an explicit action and locks duplicate acceptance until server acknowledgement',async()=>{
  let finish!:()=>void;f.accept.mockImplementation(()=>new Promise<void>(r=>{finish=r;}));render(view());
  const button=await screen.findByRole('button',{name:'Accept Admin access'});fireEvent.click(button);fireEvent.click(button);
  expect(f.accept).toHaveBeenCalledTimes(1);expect(f.accept).toHaveBeenCalledWith(offer.token);
  expect(screen.queryByText('Admin access accepted.')).toBeNull();expect((button as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>finish());expect(await screen.findByText('Admin access accepted.')).toBeTruthy();expect(document.activeElement?.getAttribute('role')).toBe('status');
 });
 it('keeps a failed offer unaccepted with safe retry copy',async()=>{
  f.accept.mockRejectedValue(new Error('secret SQL diagnostic'));render(view());fireEvent.click(await screen.findByRole('button',{name:'Accept Admin access'}));
  expect(await screen.findByRole('alert')).toBeTruthy();expect(document.body.textContent).not.toContain('secret SQL');expect(screen.queryByText('Admin access accepted.')).toBeNull();
 });
 it('can defer non-destructively and restore the offer without losing keyboard focus',async()=>{
  render(view());fireEvent.click(await screen.findByRole('button',{name:'Not now'}));const review=screen.getByRole('button',{name:'Review Admin offer'});
  expect(document.activeElement).toBe(review);expect(f.accept).not.toHaveBeenCalled();fireEvent.click(review);
  expect(screen.getByRole('heading',{name:'Admin access offered'})).toBeTruthy();expect(document.activeElement).toBe(screen.getByRole('button',{name:'Accept Admin access'}));
 });
 it('does not display an old account offer when discovery resolves after switching',async()=>{
  let finish!:(v:unknown)=>void;f.read.mockImplementationOnce(()=>new Promise(r=>{finish=r;})).mockResolvedValue(null);
  const result=render(view());f.user={id:'two'};result.rerender(view());await act(async()=>finish(offer));
  expect(screen.queryByText('Admin access offered')).toBeNull();expect(f.accept).not.toHaveBeenCalled();
 });
 it('does not resurrect accepted state after switching accounts',async()=>{
  let finish!:()=>void;f.accept.mockImplementation(()=>new Promise<void>(r=>{finish=r;}));const result=render(view());
  fireEvent.click(await screen.findByRole('button',{name:'Accept Admin access'}));f.user={id:'two'};f.read.mockResolvedValue(null);result.rerender(view());
  await act(async()=>finish());expect(screen.queryByText('Admin access accepted.')).toBeNull();
 });
 it('never reads or accepts before a completed signed-in profile exists',()=>{
  f.user=null;render(view());expect(f.read).not.toHaveBeenCalled();expect(f.accept).not.toHaveBeenCalled();
 });
});
