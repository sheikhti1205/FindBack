// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {waitFor} from '@testing-library/dom';
const f=vi.hoisted(()=>({events:[] as string[],prepare:vi.fn()}));
vi.mock('./services/dataEpoch',()=>({prepareLocalDataEpoch:()=>f.prepare()}));
vi.mock('./App',()=>{f.events.push('app-import');return {App:()=>null,createAppRouter:()=>{f.events.push('router');return {};}};});
vi.mock('./services/ai/applicationAi',()=>{f.events.push('ai-import');return {initializeApplicationAi:async()=>{f.events.push('ai-start');}};});
vi.mock('./services/monitoring/sentry',()=>({initMonitoring:()=>{f.events.push('monitoring');}}));
vi.mock('./services/monitoring/operations',()=>({recordOperation:()=>{}}));
vi.mock('react-dom/client',()=>({createRoot:()=>({render:()=>{f.events.push('render');}})}));
beforeEach(()=>{vi.resetModules();f.events.length=0;f.prepare.mockReset();document.body.innerHTML='<div id="root"></div>';history.replaceState(null,'','/');});

describe('cold-launch preservation boundary',()=>{
  it('cannot import auth/AI/router owners or render App before preparation finishes',async()=>{
    let finish!:(changed:boolean)=>void;
    f.prepare.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
    await import('./main');
    expect(f.events).toEqual([]);
    finish(false);
    await waitFor(()=>expect(f.events).toContain('render'));
    expect(f.events).toContain('ai-start');expect(f.events).toContain('router');
  });
  it('shows a truthful safe retry state and never starts owners after preparation failure',async()=>{
    f.prepare.mockRejectedValue(new Error('synthetic private stored state'));
    await import('./main');
    await waitFor(()=>expect(document.querySelector('button')?.textContent).toBe('Try again'));
    expect(document.body.textContent).toContain('Your saved data has not been cleared');
    expect(document.body.textContent).not.toContain('synthetic private');
    expect(document.documentElement.style.getPropertyValue('--fb-surface')).not.toBe('');
    expect(document.documentElement.style.getPropertyValue('--fb-primary')).not.toBe('');
    expect(f.events).toEqual([]);
  });
  it('preserves an ordinary pending route when compatibility markers change',async()=>{
    history.replaceState(null,'','/#/saved');f.prepare.mockResolvedValue(true);
    await import('./main');await waitFor(()=>expect(f.events).toContain('render'));
    expect(location.hash).toBe('#/saved');
  });
  it('captures and keeps an auth callback for the canonical auth owner after preparation',async()=>{
    history.replaceState(null,'','/auth/callback?code=synthetic-callback');f.prepare.mockResolvedValue(true);
    await import('./main');await waitFor(()=>expect(f.events).toContain('render'));
    const {takePendingExternalAuthEntry}=await import('./utils/externalAuthEntry');
    expect(location.search).toBe('');
    expect(takePendingExternalAuthEntry()).toMatchObject({kind:'auth-callback',code:'synthetic-callback'});
  });
  it('retries preparation in place without losing a captured callback',async()=>{
    history.replaceState(null,'','/auth/callback?code=synthetic-retry');
    f.prepare.mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(false);
    await import('./main');
    await waitFor(()=>expect(document.querySelector('button')?.textContent).toBe('Try again'));
    document.querySelector<HTMLButtonElement>('button')!.click();
    await waitFor(()=>expect(f.events).toContain('render'));
    const {takePendingExternalAuthEntry}=await import('./utils/externalAuthEntry');
    expect(takePendingExternalAuthEntry()).toMatchObject({kind:'auth-callback',code:'synthetic-retry'});
  });
});
