import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  mode: 'router' as 'router' | 'legacy' | 'pending',
  view: { state: 'LIVE', value: { needs: { items: [] }, saved: { windowId: 'window', rows: [], next: 'next' } },
    cut: { stream: 'workspace:ws', epoch: '1', through: 3, protocol: 1 }, error: null } as any,
  pageView:null as any,pageViews:new Map<string,any>(),page:vi.fn(),pageRelease:vi.fn(),
  listeners: new Set<() => void>(), release: vi.fn(), acquire: vi.fn(), retry: vi.fn(),
  prepare: vi.fn(), deliver: vi.fn(), cancel: vi.fn(), admit: vi.fn(), paint: vi.fn(), capable: true,
}));
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('./router-family', () => ({ useRouterFamily: () => fixture.mode }));
vi.mock('./router-owner', () => ({
  routerFamilyMode: () => fixture.mode,
  acquireRouterLane: (...args: unknown[]) => {
    fixture.acquire(...args);
    return { current: () => fixture.view, release: fixture.release,
      subscribe: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); } };
  },
  acquireRouterSavedContinuation:(...args:unknown[])=>{fixture.page(...args);fixture.listeners.add(args[3] as ()=>void);return {current:()=>fixture.pageViews.get(args[1] as string)??fixture.pageView,release:fixture.pageRelease};},
  retryRouterLane: fixture.retry,
  admitRouterTrayCommand: fixture.admit,
  admitRouterTrayPaint: fixture.paint,
}));
vi.mock('./command-owner', () => ({ activeCommandOwner: () => ({
  canPrepare: () => fixture.capable, prepare: fixture.prepare, deliver: fixture.deliver, cancel: fixture.cancel,
}) }));

import { useRoutedTray, prepareTrayCommand, acknowledgeRoutedTrayPaint } from './router-tray';
let tree: ReturnType<typeof create> | undefined;
let latest: ReturnType<typeof useRoutedTray>;
function Probe({ workspaceId = 'ws', focused = true }: { workspaceId?: string; focused?: boolean }) {
  latest = useRoutedTray(workspaceId, focused);
  return null;
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.mode = 'router'; fixture.capable = true;
  fixture.view = { state: 'LIVE', value: { needs: { items: [] }, saved: { windowId: 'window', rows: [], next: 'next' } },
    cut: { stream: 'workspace:ws', epoch: '1', through: 3, protocol: 1 }, error: null };
  fixture.pageView={state:'OPENING',value:null,cut:null,error:null};fixture.pageViews.clear();
  fixture.listeners.clear(); fixture.admit.mockReturnValue({ wire: { operation: 'clearNeedsYouSection' } });
  fixture.paint.mockReturnValue([]); fixture.prepare.mockResolvedValue({ id: 'intent' });
  fixture.deliver.mockResolvedValue(undefined); fixture.cancel.mockResolvedValue(undefined);
});
afterEach(() => { if (tree) act(() => tree.unmount()); tree = undefined; });

describe('Tray canonical observation', () => {
  it('paints the server DTO as-is and observes a pushed replacement without a read', () => {
    act(() => { tree = create(React.createElement(Probe)); });
    expect(latest.value).toBe(fixture.view.value);
    const replacement = { needs: { items: [{ messageId: 'server-ordered' }] }, saved: { windowId: 'window', rows: [] } };
    act(() => { fixture.view = { ...fixture.view, value: replacement }; fixture.listeners.forEach(fn => fn()); });
    expect(latest.value).toBe(replacement);
    expect(fixture.acquire).toHaveBeenCalledTimes(1);
    expect(fixture.retry).not.toHaveBeenCalled();
  });
  it('loads only the clicked held continuation, co-paints matching cuts and releases pages on blur',()=>{
    act(()=>{tree=create(React.createElement(Probe));});
    expect(fixture.page).not.toHaveBeenCalled();
    act(()=>{latest.loadMoreSaved();latest.loadMoreSaved();});
    expect(fixture.page).toHaveBeenCalledTimes(1);expect(fixture.page.mock.calls[0]!.slice(0,2)).toEqual(['ws','next']);
    expect(latest.savedLoading).toBe(true);
    const row={bookmarkId:'one',value:{messageId:'older'}};
    act(()=>{fixture.pageView={state:'LIVE',value:{windowId:'older',before:'next',rows:[row]},cut:{...fixture.view.cut,through:4},error:null};fixture.listeners.forEach(fn=>fn());});
    expect(latest.savedRows).toEqual([]);
    act(()=>{fixture.view={...fixture.view,cut:{...fixture.view.cut,through:4}};fixture.listeners.forEach(fn=>fn());});
    expect(latest.savedRows).toEqual([row]);expect(latest.savedNext).toBeUndefined();
    act(()=>{tree!.update(React.createElement(Probe,{focused:false}));});
    expect(latest.savedRows).toEqual([]);expect(fixture.pageRelease).toHaveBeenCalledTimes(1);
  });
  it('keeps held history through head trims and reads a missing cursor window only on click',()=>{
    const older={bookmarkId:'old',order:'1,old',value:{messageId:'older'}},trimmed={bookmarkId:'trimmed',order:'2,trimmed',value:{messageId:'trimmed'}};
    act(()=>{tree=create(React.createElement(Probe));});
    act(()=>{latest.loadMoreSaved();});
    act(()=>{fixture.pageViews.set('next',{state:'LIVE',value:{windowId:'older',before:'next',rows:[older]},cut:fixture.view.cut,error:null});fixture.listeners.forEach(fn=>fn());});
    for(let n=0;n<100;n++)act(()=>{
      fixture.view={...fixture.view,value:{needs:{items:[]},saved:{windowId:'window',rows:[],next:`gap${n}`}}};
      fixture.listeners.forEach(fn=>fn());
    });
    expect(fixture.page).toHaveBeenCalledTimes(1);expect(latest.savedRows).toEqual([older]);expect(latest.savedNext).toBe('gap99');
    act(()=>{latest.loadMoreSaved();});expect(fixture.page).toHaveBeenCalledTimes(2);
    expect(fixture.page.mock.calls[1]!.slice(0,2)).toEqual(['ws','gap99']);
    act(()=>{fixture.pageViews.set('gap99',{state:'LIVE',value:{windowId:'bridge',before:'gap99',rows:[trimmed,older],next:'next'},cut:fixture.view.cut,error:null});fixture.listeners.forEach(fn=>fn());});
    expect(latest.savedRows).toEqual([trimmed,older]);expect(latest.savedNext).toBeUndefined();
    expect(fixture.acquire).toHaveBeenCalledTimes(1);expect(fixture.retry).not.toHaveBeenCalled();
  });

  it('hides a prior DTO synchronously on pending, blur and Workspace change', () => {
    const observed: unknown[] = [];
    function RecordingProbe(props: { workspaceId?: string; focused?: boolean }) {
      const state = useRoutedTray(props.workspaceId ?? 'ws', props.focused ?? true);
      observed.push(state.value); return null;
    }
    act(() => { tree = create(React.createElement(RecordingProbe)); });
    observed.length = 0; fixture.mode = 'pending';
    act(() => { tree.update(React.createElement(RecordingProbe)); });
    expect(observed.every(value => value === null)).toBe(true);
    fixture.mode = 'router';
    act(() => { tree.update(React.createElement(RecordingProbe)); });
    observed.length = 0;
    act(() => { tree.update(React.createElement(RecordingProbe, { focused: false })); });
    expect(observed.every(value => value === null)).toBe(true);
    act(() => { tree.update(React.createElement(RecordingProbe)); });
    observed.length = 0;
    act(() => { tree.update(React.createElement(RecordingProbe, { workspaceId: 'other' })); });
    // The first render cannot expose the prior handle before effect detaches it.
    expect(observed[0]).toBe(null);
  });
  it('attaches no canonical lane in explicit legacy mode', () => {
    fixture.mode = 'legacy'; act(() => { tree = create(React.createElement(Probe)); });
    expect(fixture.acquire).not.toHaveBeenCalled(); expect(latest.value).toBe(null);
  });
});

describe('Tray immutable actions', () => {
  it('reserves synchronously, then Undo cancels a still-persisting intent before any send', async () => {
    let persist!: (record: { id: string }) => void;
    fixture.prepare.mockReturnValue(new Promise(resolve => { persist = resolve; }));
    const action = prepareTrayCommand('ws', { operation: 'clearNeedsYouSection', input: { workspaceId: 'ws' } })!;
    expect(fixture.admit).toHaveBeenCalledTimes(1); expect(fixture.prepare).toHaveBeenCalledTimes(1);
    const cancel = action.cancel(); const deliver = action.deliver();
    persist({ id: 'immutable' }); await Promise.all([cancel, deliver]);
    expect(fixture.cancel).toHaveBeenCalledWith('immutable'); expect(fixture.deliver).not.toHaveBeenCalled();
  });
  it('the existing Undo deadline sends only its original immutable record without reminting', async () => {
    const action = prepareTrayCommand('ws', { operation: 'clearMessageBookmarks', input: { workspaceId: 'ws' } })!;
    await action.ready; await action.deliver();
    expect(fixture.admit).toHaveBeenCalledTimes(1); expect(fixture.deliver).toHaveBeenCalledWith('intent');
    expect(fixture.retry).not.toHaveBeenCalled();
  });
  it('fails closed while pending or command durability is unavailable', () => {
    const command = { operation: 'clearMessageBookmarks' as const, input: { workspaceId: 'ws' } };
    fixture.mode = 'pending'; expect(() => prepareTrayCommand('ws', command)).toThrow('unavailable');
    fixture.mode = 'router'; fixture.capable = false;
    expect(() => prepareTrayCommand('ws', command)).toThrow('unavailable');
    expect(fixture.admit).not.toHaveBeenCalled(); fixture.mode = 'legacy';
    expect(prepareTrayCommand('ws', command)).toBeUndefined();
  });
  it('paint spends owner-validated batches and delivers them without fetching rows', async () => {
    fixture.paint.mockReturnValue([{ wire: { operation: 'markNeedsYouSeen' } }, { wire: { operation: 'markNeedsYouSeen' } }]);
    await acknowledgeRoutedTrayPaint('ws', ['painted-a', 'painted-b']);
    expect(fixture.paint).toHaveBeenCalledWith('ws', ['painted-a', 'painted-b']);
    expect(fixture.prepare).toHaveBeenCalledTimes(2); expect(fixture.deliver).toHaveBeenCalledTimes(2);
    expect(fixture.acquire).not.toHaveBeenCalled();
  });
  it('admits every actually painted ID in bounded batches on the same event', async () => {
    const ids = Array.from({ length: 65 }, (_, index) => `painted-${index}`);
    await acknowledgeRoutedTrayPaint('ws', [...ids, ids[0]!]);
    expect(fixture.paint.mock.calls.map(([, batch]) => batch.length)).toEqual([30, 30, 5]);
    expect(fixture.paint.mock.calls.flatMap(([, batch]) => batch)).toEqual(ids);
  });
});
