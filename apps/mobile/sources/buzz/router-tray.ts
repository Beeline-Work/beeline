import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { RouterValues } from '@beeline/api-contract/router-protocol';
import { acquireRouterLane, acquireRouterSavedContinuation, retryRouterLane, routerFamilyMode,
  admitRouterTrayCommand, admitRouterTrayPaint, type TrayCommand } from './router-owner';
import { useRouterFamily } from './router-family';
import { activeCommandOwner } from './command-owner';

export type { TrayCommand } from './router-owner';
export interface PreparedTrayCommand {
  readonly ready: Promise<void>;
  deliver(): Promise<void>;
  cancel(): Promise<void>;
}

const empty = Object.freeze({ state: 'ABSENT' as const, value: null, error: null, cut: null });
const noop = () => {};
const detached = () => noop;

/** The navigation owner admits the read. Rendering/reattaching only observes
 * its canonical DTO; neither legacy invalidations nor command results reload it.
 */
export function useRoutedTray(workspaceId: string, focused: boolean) {
  const mode = useRouterFamily('needs-you-tray');
  const visible = useRef(focused);
  visible.current = focused;
  const request = useMemo(() => workspaceId
    ? { family: 'needs-you-tray' as const, workspaceId } : undefined, [workspaceId]);
  const [lane, setLane] = useState<{ workspaceId: string; handle: ReturnType<typeof acquireRouterLane> }>();
  useEffect(() => {
    if (mode !== 'router' || !focused || !request) { setLane(undefined); return; }
    const handle = acquireRouterLane(request,
      () => visible.current && AppState.currentState === 'active', noop);
    setLane({ workspaceId: request.workspaceId, handle });
    return handle.release;
  }, [mode, focused, request]);
  const pages=useRef<{workspaceId:string;handles:ReturnType<typeof acquireRouterLane>[];cursors:Set<string>} >({workspaceId,handles:[],cursors:new Set()});
  const [,publishPages]=useState(0);
  useEffect(()=>{
    pages.current={workspaceId,handles:[],cursors:new Set()};publishPages(value=>value+1);
    return()=>{for(const page of pages.current.handles)page.release();pages.current={workspaceId:'',handles:[],cursors:new Set()};};
  },[workspaceId,focused,mode]);
  // This synchronous gate prevents a prior private DTO painting while effect
  // cleanup is still pending after negotiation, Workspace change or blur.
  const current = mode === 'router' && focused && lane?.workspaceId === workspaceId
    ? lane.handle : undefined;
  const view = useSyncExternalStore(current?.subscribe ?? detached,
    () => current?.current() ?? empty, () => empty);
  const value=mode==='router'?view.value as RouterValues['needs-you-tray']|null:null;
  const pageViews=mode==='router'&&focused&&pages.current.workspaceId===workspaceId?pages.current.handles.map(handle=>handle.current()):[];
  const coherent=pageViews.filter(page=>value&&view.cut&&page.value&&page.cut?.stream===view.cut?.stream&&page.cut?.epoch===view.cut?.epoch&&page.cut?.through===view.cut?.through);
  const windows=[...(value?[value.saved]:[]),...coherent.map(page=>page.value as RouterValues['needs-you-saved-page'])];
  const seen=new Set<string>();
  const savedRows=windows.flatMap(window=>window.rows).filter(row=>{if(seen.has(row.bookmarkId))return false;seen.add(row.bookmarkId);return true;});
  // A pushed head can trim a row ahead of an already-held historical page.
  // Follow server-authored cursor links to the first missing window; only the
  // actual button may request that gap. Keep all coherent held rows visible.
  savedRows.sort((a,b)=>{
    const [at,ai]=a.order.split(','),[bt,bi]=b.order.split(',');
    const left=BigInt(at!),right=BigInt(bt!);
    return left===right?(ai!<bi!?-1:ai!>bi!?1:0):left>right?-1:1;
  });
  const continuations=new Map(windows.filter(window=>window.before!==undefined).map(window=>[window.before!,window]));
  const traversed=new Set<string>();let savedNext=value?.saved.next,cycle=false;
  while(savedNext&&continuations.has(savedNext)){
    if(traversed.has(savedNext)){cycle=true;savedNext=undefined;break;}
    traversed.add(savedNext);savedNext=continuations.get(savedNext)!.next;
  }
  const savedLoading=pageViews.some(page=>page.state==='OPENING');
  const savedError=pageViews.find(page=>page.error)?.error??(cycle?'Saved continuation unavailable.':null);
  return {
    mode,
    value,savedRows,savedNext,savedLoading,savedError,
    loadMoreSaved:()=>{
      if(mode!=='router'||!focused||!savedNext||savedLoading||pages.current.cursors.has(savedNext))return;
      const handle=acquireRouterSavedContinuation(workspaceId,savedNext,()=>visible.current&&AppState.currentState==='active',()=>publishPages(value=>value+1));
      pages.current.cursors.add(savedNext);pages.current.handles.push(handle);publishPages(value=>value+1);
    },
    cut: mode === 'router' ? view.cut : null,
    error: mode === 'router' ? view.error : null,
    loading: !!workspaceId && (mode === 'pending' || mode === 'router' &&
      (view.state === 'ABSENT' || view.state === 'OPENING')),
    retry: () => { if (mode === 'router' && focused && request) {
      for(const page of pages.current.handles)page.release();
      pages.current={workspaceId,handles:[],cursors:new Set()};publishPages(value=>value+1);
      retryRouterLane(request);
    } },
  };
}

/** The existing gesture reserves immutable bytes before its first await.
 * A section's existing Undo deadline may send this prepared intent, but cannot
 * create a pass or reconstruct command input after the gesture returns.
 */
export function prepareTrayCommand(workspaceId: string, command: TrayCommand): PreparedTrayCommand | undefined {
  const mode = routerFamilyMode('needs-you-tray');
  if (mode === 'legacy') return;
  const owner = activeCommandOwner();
  if (mode !== 'router' || !owner?.canPrepare()) throw new Error('Tray command delivery is unavailable.');
  const record = owner.prepare(admitRouterTrayCommand(workspaceId, command));
  let cancelled = false;
  const ready = record.then(() => undefined);
  // Immediate actions await delivery instead; preserve a rejectable `ready`
  // for held Undo intents without creating an unobserved sibling rejection.
  void ready.catch(() => undefined);
  let delivery: Promise<void> | undefined;
  return {
    ready,
    deliver: () => delivery ??= (async () => {
      const value = await record;
      if (!cancelled) await owner.deliver(value.id);
    })(),
    cancel: async () => { cancelled = true; await owner.cancel((await record).id); },
  };
}

/** Invoked by the focused FlatList's post-paint viewport boundary. The private
 * owner validates held DTO IDs and consumes residency dedupe before persistence.
 */
export async function acknowledgeRoutedTrayPaint(workspaceId: string, messageIds: readonly string[]): Promise<void> {
  if (routerFamilyMode('needs-you-tray') !== 'router') return;
  const owner = activeCommandOwner();
  if (!owner?.canPrepare()) throw new Error('Tray command delivery is unavailable.');
  const ids = [...new Set(messageIds)];
  if (ids.length > 500) throw new Error('Tray paint exceeds its projection bound.');
  const records = [];
  for (let offset = 0; offset < ids.length; offset += 30)
    records.push(...admitRouterTrayPaint(workspaceId, ids.slice(offset, offset + 30)).map(admitted => owner.prepare(admitted)));
  await Promise.all(records.map(async record => { await owner.deliver((await record).id); }));
}
