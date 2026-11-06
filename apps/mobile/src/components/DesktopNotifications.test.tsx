// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { DesktopNotifications } from './DesktopNotifications';
import type { NotificationItem } from '../services/notifications';
const m=vi.hoisted(()=>({user:{id:'a'},listen:vi.fn(),fetch:vi.fn(),prefs:vi.fn(),show:vi.fn(),close:vi.fn(),enabled:vi.fn()}));
vi.mock('../auth',()=>({useAuth:()=>({user:m.user})}));
vi.mock('../services/realtime',()=>({onRealtime:m.listen}));
vi.mock('../services/notifications',()=>({fetchNotifications:m.fetch}));
vi.mock('../services/notificationPreferences',()=>({fetchNotificationPreferences:m.prefs}));
vi.mock('../services/desktopNotifications',()=>({desktopNotificationsEnabled:m.enabled,showDesktopNotification:m.show,closeDesktopNotifications:m.close}));
vi.mock('../screens/Notifications',()=>({typeLabel:()=> 'commented',notificationRoute:()=>'/notifications'}));
let signal:()=>void;
function item(extra:Partial<NotificationItem>={}):NotificationItem {return {id:'new',type:'COMMENT',preview:'private comment',read:false,createdAt:new Date(Date.now()+1000).toISOString(),actorId:'p',actorUsername:'peer',postId:'post',postTitle:'title',commentId:'c',reactionKind:null,...extra};}
beforeEach(()=>{
  vi.resetAllMocks();m.user={id:'a'};
  vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
  m.listen.mockImplementation((_event,cb)=>{signal=cb;return ()=>{};});
  m.enabled.mockReturnValue(true);m.fetch.mockResolvedValue([item()]);
  m.prefs.mockResolvedValue({pushEnabled:true,comments:true,mentions:true,likes:true,status:true});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
async function notify(){await act(async()=>{signal();await Promise.resolve();});}
it('shows fresh unread activity, never old unread rows',async()=>{
  m.fetch.mockResolvedValue([item(),item({id:'old',createdAt:'2020-01-01T00:00:00Z'})]);
  render(<MemoryRouter><DesktopNotifications/></MemoryRouter>);await notify();
  expect(m.show).toHaveBeenCalledTimes(1);expect(m.show).toHaveBeenCalledWith('a',expect.objectContaining({tag:'new'}));
});
it('honors the master and category settings',async()=>{
  render(<MemoryRouter><DesktopNotifications/></MemoryRouter>);
  m.prefs.mockResolvedValue({pushEnabled:false,comments:true});await notify();expect(m.show).not.toHaveBeenCalled();
  m.prefs.mockResolvedValue({pushEnabled:true,comments:false});await notify();expect(m.show).not.toHaveBeenCalled();
});
it('keeps blocked actor previews out of the OS notification',async()=>{
  m.fetch.mockResolvedValue([item({blockedActor:true})]);render(<MemoryRouter><DesktopNotifications/></MemoryRouter>);await notify();
  expect(m.show).toHaveBeenCalledWith('a',expect.objectContaining({title:'New activity in Norfold',body:'Open your inbox to review it.'}));
});
it('drops a late account-A result after account B replaces it',async()=>{
  let finish!:(value:NotificationItem[])=>void;m.fetch.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  const view=render(<MemoryRouter><DesktopNotifications/></MemoryRouter>);signal();
  m.user={id:'b'};view.rerender(<MemoryRouter><DesktopNotifications/></MemoryRouter>);
  await act(async()=>{finish([item()]);});expect(m.show).not.toHaveBeenCalled();expect(m.close).toHaveBeenCalledWith('a');
});
