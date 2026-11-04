import { describe, expect, it } from 'vitest';
import { ReadLanes, type LaneBatch, type LaneSnapshot } from './private/read-lanes.js';
import { RouterBatchAssembly, type RouterPart } from './private/batch-assembly.js';
import { NavigationOwner } from './private/navigation-owner.js';
const identity = { origin: 'https://example.test', principal: 'ada', sessionEpoch: 1 };
const request = { family: 'needs-you-count', workspaceId: 'w' } as const;
const authority = { digest: 'certificate', scopes: [{ authorityScope: 'reader:ada:workspace:w', epoch: '1' }] };
const snapshot = (through = 1, value: unknown = { count: 1 }): LaneSnapshot => ({ kind: 'snapshot', value,
  cut: { protocol: 1, stream: 'workspace:w', epoch: 'stream-1', through }, atomicGroup: 'needs:w:ada', authority });
const batch = (from: number, to: number, value: unknown = { count: to }): LaneBatch => ({
  from: snapshot(from).cut, to: snapshot(to).cut, facts: [{ atomicGroup: 'needs:w:ada', authority,
    payload: { kind: 'scope-replace', family: request.family, scope: 'w', value } }],
});
const permit = { isCurrent: () => true };
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(execute: () => Promise<LaneSnapshot> = async () => snapshot()) {
  const lanes = new ReadLanes(identity, (_request, value) => typeof (value as { count?: unknown })?.count === 'number');
  lanes.connected(1, [request.family], execute);
  return lanes;
}

describe('local read lanes (P2)', () => {
  it('reuses committed coverage when the initial LIVE observer immediately blurs before the opening promise unwinds',async()=>{
    let reads=0,release=()=>{},blurred!:()=>void;
    const done=new Promise<void>(resolve=>{blurred=resolve;});
    const lanes=setup(async()=>{reads++;return snapshot();});
    let first=true;
    lanes.subscribe(request,()=>{
      if(first&&lanes.peek(request).state==='LIVE'){first=false;release();blurred();}
    });
    release=lanes.demand(request,{},permit);await done;
    expect(lanes.peek(request)).toMatchObject({state:'INACTIVE_CACHED',value:{count:1}});
    lanes.demand(request,{},permit);await drain();
    expect(lanes.peek(request)).toMatchObject({state:'LIVE',value:{count:1}});expect(reads).toBe(1);
  });
  it('keeps LIVE data visible without an error throughout an in-place refresh', async () => {
    let reads = 0;
    let resolve!: (value: LaneSnapshot) => void;
    const lanes = setup(async () => ++reads === 1 ? snapshot() : new Promise(done => { resolve = done; }));
    lanes.demand(request, {}, permit); await drain();
    const views: ReturnType<ReadLanes['peek']>[] = [];
    lanes.subscribe(request, () => views.push(lanes.peek(request)));

    lanes.refresh();
    expect(lanes.peek(request)).toMatchObject({ state: 'LIVE', value: { count: 1 }, error: null, refreshing: true });
    await drain();
    expect(reads).toBe(2);
    resolve(snapshot(2, { count: 2 })); await drain();
    expect(lanes.peek(request)).toMatchObject({ state: 'LIVE', value: { count: 2 }, error: null, refreshing: false });
    expect(views.length).toBeGreaterThan(0);
    expect(views.every(view => view.state === 'LIVE' && view.error === null && view.value !== null)).toBe(true);
  });

  it('keeps an inactive cache visible and opens its invalidated coverage when demanded again', async () => {
    let reads = 0;
    let resolve!: (value: LaneSnapshot) => void;
    const lanes = setup(async () => ++reads === 1 ? snapshot() : new Promise(done => { resolve = done; }));
    const release = lanes.demand(request, {}, permit); await drain(); release();
    lanes.refresh(); await drain();
    expect(lanes.peek(request)).toMatchObject({ state: 'INACTIVE_CACHED', value: { count: 1 }, error: null });
    expect(reads).toBe(1);
    lanes.demand(request, {}, permit); await drain();
    expect(lanes.peek(request)).toMatchObject({ state: 'INACTIVE_CACHED', value: { count: 1 }, error: null, refreshing: true });
    resolve(snapshot(2)); await drain();
    expect(lanes.peek(request)).toMatchObject({ state: 'LIVE', error: null, refreshing: false });
    expect(reads).toBe(2);
  });

  it('reports a refresh error only after the re-read fails', async () => {
    let reads = 0;
    let reject!: (reason: Error) => void;
    const lanes = setup(async () => ++reads === 1 ? snapshot() : new Promise((_resolve, fail) => { reject = fail; }));
    lanes.demand(request, {}, permit); await drain();
    lanes.refresh(); await drain();
    expect(lanes.peek(request)).toMatchObject({ state: 'LIVE', value: { count: 1 }, error: null, refreshing: true });
    reject(new Error('offline')); await drain();
    expect(lanes.peek(request)).toMatchObject({ state: 'PARKED', value: { count: 1 }, error: "Couldn't load this. Retry.", refreshing: false });
  });

  it('still hides data immediately when refresh follows an authority failure', async () => {
    let reads = 0;
    let resolve!: (value: LaneSnapshot) => void;
    const lanes = setup(async () => ++reads === 1 ? snapshot() : new Promise(done => { resolve = done; }));
    lanes.demand(request, {}, permit); await drain();
    lanes.refresh(() => true, true);
    expect(lanes.peek(request)).toMatchObject({ state: 'OPENING', value: null, error: null });
    await drain(); resolve(snapshot(2)); await drain();
    expect(lanes.peek(request)).toMatchObject({ state: 'LIVE', error: null });
  });

  it('unavailable re-reads only its lane and a failed read parks only that item', async () => {
    const other = { ...request, workspaceId: 'other' };
    const calls: string[] = [];
    let failing = false;
    const lanes = new ReadLanes(identity, () => true);
    lanes.connected(1, [request.family], async input => {
      calls.push(input.workspaceId!);
      if (input.workspaceId === 'w' && failing) throw new Error('unavailable');
      return { ...snapshot(), cut: { ...snapshot().cut, stream: `workspace:${input.workspaceId}` } };
    });
    lanes.demand(request, {}, permit); lanes.demand(other, {}, permit); await drain();
    failing = true;
    lanes.unavailable('workspace:w', request.family); await drain();
    expect(calls).toEqual(['w', 'other', 'w']);
    expect(lanes.peek(request)).toMatchObject({ state: 'PARKED', error: "Couldn't load this. Retry." });
    expect(lanes.peek(other)).toMatchObject({ state: 'LIVE', error: null });
    failing = false;
    lanes.unavailable('workspace:w', request.family); await drain();
    expect(calls).toEqual(['w', 'other', 'w', 'w']);
    expect(lanes.peek(request)).toMatchObject({ state: 'LIVE', error: null });
  });

  it('coalesces two owners into one read; a second LIVE owner consumes no read', async () => {
    let reads = 0;
    const lanes = setup(async () => { reads++; return snapshot(); });
    const releaseA = lanes.demand(request, {}, permit);
    const releaseB = lanes.demand(request, {}, permit);
    await drain();
    expect(reads).toBe(1);
    expect(lanes.peek(request).state).toBe('LIVE');
    releaseA();
    expect(lanes.peek(request).state).toBe('LIVE');
    const releaseC = lanes.demand(request, {}, permit);
    expect(reads).toBe(1);
    releaseB(); releaseC();
    expect(lanes.peek(request).state).toBe('INACTIVE_CACHED');
    lanes.demand(request, {}, permit);
    await drain();
    expect(reads).toBe(1);
    expect(lanes.peek(request).state).toBe('LIVE');
  });
  it('reactivates a continuously updated inactive cache without a new read',async()=>{
    let reads=0;const lanes=setup(async()=>{reads++;return snapshot();});
    const release=lanes.demand(request,{},permit);await drain();release();
    await lanes.accept(batch(1,2));
    expect(lanes.peek(request)).toMatchObject({state:'INACTIVE_CACHED',value:{count:2},cut:{through:2}});
    lanes.demand(request,{},permit);await drain();
    expect(lanes.peek(request)).toMatchObject({state:'LIVE',value:{count:2}});expect(reads).toBe(1);
  });
  it('a Room head without an inactive source feed hides on departure and uses only a fresh focus miss',async()=>{
    const room={family:'room-head',roomId:'room-a',workspaceId:'w'} as const;let reads=0;
    const lanes=new ReadLanes(identity,()=>true);lanes.connected(1,['room-head'],async()=>({...snapshot(),value:{revision:++reads}}));
    const release=lanes.demand(room,{},permit);await drain();expect(lanes.peek(room)).toMatchObject({state:'LIVE',value:{revision:1}});
    release();expect(lanes.peek(room)).toMatchObject({state:'PARKED',value:null,cut:null,error:expect.stringContaining('Retry')});
    // Another Workspace batch says nothing about this filtered-out Room.
    await lanes.accept({...batch(1,2),facts:[]});expect(reads).toBe(1);expect(lanes.peek(room).value).toBeNull();
    lanes.demand(room,{},permit);expect(lanes.peek(room).value).toBeNull();await drain();
    expect(lanes.peek(room)).toMatchObject({state:'LIVE',value:{revision:2}});expect(reads).toBe(2);
  });
  it('healthy Room foreground observation reuses its token without a read and exposes the existing Retry',async()=>{
    const room={family:'room-head',roomId:'room-a',workspaceId:'w'} as const,token={};let reads=0;
    const lanes=new ReadLanes(identity,()=>true);lanes.connected(1,['room-head'],async()=>({...snapshot(),value:{revision:++reads}}));
    const release=lanes.demand(room,token,permit);await drain();release();lanes.demand(room,token,permit);await drain();
    expect(reads).toBe(1);expect(lanes.peek(room)).toMatchObject({state:'PARKED',value:null,error:expect.stringContaining('Retry')});
    lanes.retry(room,permit);await drain();expect(reads).toBe(2);expect(lanes.peek(room)).toMatchObject({state:'LIVE',value:{revision:2}});
  });
  it('a real disconnected cache miss and a parked lane still require fresh owner admission',async()=>{
    let reads=0;const execute=async()=>{reads++;return snapshot(reads);};const lanes=setup(execute);
    let release=lanes.demand(request,{},permit);await drain();release();lanes.disconnected();
    lanes.connected(2,[request.family],execute);expect(reads).toBe(1);expect(lanes.peek(request).value).toBeNull();
    release=lanes.demand(request,{},permit);await drain();expect(reads).toBe(2);
    lanes.unavailable('workspace:w',request.family);release();
    expect(lanes.peek(request).state).toBe('PARKED');
    lanes.demand(request,{},permit);await drain();expect(reads).toBe(3);
  });
  it('never reclassifies revoked content as a reusable inactive cache',async()=>{
    let reads=0;const lanes=setup(async()=>{reads++;return snapshot();});
    const release=lanes.demand(request,{},permit);await drain();await lanes.revoke(authority.scopes[0]!.authorityScope,'2');release();
    expect(lanes.peek(request)).toMatchObject({state:'REVOKED',value:null});
    lanes.demand(request,{},permit);await drain();
    expect(reads).toBe(2);expect(lanes.peek(request).value).toBeNull();
  });
  it('does not reuse a cache whose in-flight group commit was discarded on departure',async()=>{
    let writes=0,reads=0,started!:()=>void,finish!:()=>void;
    const writing=new Promise<void>(done=>{started=done;}),released=new Promise<void>(done=>{finish=done;});
    const lanes=new ReadLanes(identity,()=>true,{write:async()=>{if(++writes===2){started();await released;}},fence:async()=>{},remove:async()=>{}});
    lanes.connected(1,[request.family],async()=>{reads++;return snapshot(reads);});
    const release=lanes.demand(request,{},permit);await drain();
    const applying=lanes.accept(batch(1,2));await writing;release();finish();await applying;
    expect(lanes.peek(request).state).toBe('PARKED');lanes.demand(request,{},permit);await drain();expect(reads).toBe(2);
  });
  it('coalesces roomId-only and Workspace-known heads, rejecting contradictory scope', async () => {
    let reads = 0;
    const room = { family: 'room-head', roomId: 'room-a' } as const;
    const lanes = new ReadLanes(identity, () => true);
    lanes.connected(1, ['room-head'], async () => { reads++; return snapshot(); });
    lanes.demand(room, {}, permit);
    lanes.demand({ ...room, workspaceId: 'w' }, {}, permit);
    await drain();
    expect(reads).toBe(1);
    expect(lanes.key(room)).toBe(lanes.key({ ...room, workspaceId: 'w' }));
    expect(lanes.peek({ ...room, workspaceId: 'w' }).state).toBe('LIVE');
    expect(() => lanes.demand({ ...room, workspaceId: 'other' }, {}, permit)).toThrow('Room Workspace mismatch');
    expect(() => lanes.peek({ ...room, workspaceId: 'other' })).toThrow('Room Workspace mismatch');
  });
  it('fences released flights and parks a failed first read without retry', async () => {
    let resolve!: (value: LaneSnapshot) => void;
    const lanes = setup(() => new Promise(done => { resolve = done; }));
    const release = lanes.demand(request, {}, permit);
    await drain(); release(); resolve(snapshot()); await drain();
    expect(lanes.peek(request).value).toBeNull();
    let reads = 0;
    const failed = setup(async () => { reads++; throw new Error('offline'); });
    failed.demand(request, {}, permit); await drain();
    expect(failed.peek(request).state).toBe('PARKED');
    await failed.accept(batch(1, 2)); await drain();
    expect(reads).toBe(1);
    failed.retry(request, permit); await drain();
    expect(reads).toBe(2);
  });
  it('receives current server replacements without reading and rejects stale duplicate cuts', async () => {
    let reads = 0;
    const lanes = setup(async () => { reads++; return snapshot(); });
    lanes.demand(request, {}, permit); await drain();
    await lanes.accept(batch(1, 2));
    await lanes.accept(batch(1, 2, { count: 99 }));
    expect(lanes.peek(request).value).toEqual({ count: 2 });
    expect(reads).toBe(1);
  });
  it('stages future complete batches until continuity arrives without rereading', async () => {
    let reads = 0;
    const lanes = setup(async () => { reads++; return snapshot(); });
    lanes.demand(request, {}, permit); await drain();
    await lanes.accept(batch(2, 3));
    expect(lanes.peek(request).value).toEqual({ count: 1 });
    await lanes.accept(batch(1, 2)); await drain();
    expect(lanes.peek(request).value).toEqual({ count: 3 });
    expect(reads).toBe(1);
  });
  it('buffers facts arriving before the snapshot and applies them after the baseline', async () => {
    let resolve!: (value: LaneSnapshot) => void;
    const lanes = setup(() => new Promise(done => { resolve = done; }));
    lanes.demand(request, {}, permit); await drain();
    await lanes.accept(batch(1, 2));
    expect(lanes.peek(request).value).toBeNull();
    resolve(snapshot()); await drain();
    expect(lanes.peek(request).value).toEqual({ count: 2 });
  });
  it('buffers one legal primary batch larger than 256KiB while the initial snapshot opens', async () => {
    let resolve!: (value: LaneSnapshot) => void;
    const lanes = setup(() => new Promise(done => { resolve = done; }));
    lanes.demand(request, {}, permit); await drain();
    const large = batch(1, 2);
    const projections = Array.from({ length: 5 }, (_, index) => ({ atomicGroup: `room:${index}`, authority,
      payload: { kind: 'scope-replace' as const, family: 'room-head' as const, scope: `other-room-${index}`,
        value: { padding: 'x'.repeat(63 * 1024) } } }));
    await lanes.accept({ ...large, facts: [...projections, ...large.facts] });
    expect(lanes.peek(request).state).toBe('OPENING');
    resolve(snapshot()); await drain();
    expect(lanes.peek(request).value).toEqual({ count: 2 });
  });
  it('does one recovery read per currently demanded key on a real generation', async () => {
    let reads = 0;
    const execute = async () => { reads++; return snapshot(); };
    const lanes = setup(execute);
    lanes.demand(request, {}, permit); await drain();
    lanes.connected(2, [request.family], execute); await drain();
    expect(reads).toBe(2);
    expect(() => lanes.connected(2, [request.family], execute)).toThrow('stale lane connection');
  });
  it('hides private data across interruption and ignores old generation replies', async () => {
    const lanes = setup(); lanes.demand(request, {}, permit); await drain();
    expect(lanes.peek(request).value).toEqual({ count: 1 });
    lanes.disconnected();
    expect(lanes.peek(request).value).toBeNull();
    await lanes.accept(batch(1, 2));
    expect(lanes.peek(request).value).toBeNull();
  });
  it('writes one coherent atomic group before notifying either observer', async () => {
    const writes: string[] = [];
    const lanes = new ReadLanes(identity, () => true, { write: async (_key, encoded) => { writes.push(encoded); },
      fence: async () => {}, remove: async () => {} });
    lanes.connected(1, [request.family], async () => snapshot());
    lanes.demand(request, {}, permit); await drain();
    const encoded = JSON.parse(writes[0]!);
    expect(encoded.entries[0].snapshot.cut.through).toBe(1);
    expect(encoded.entries[0].snapshot.value).toEqual({ count: 1 });
    expect(lanes.peek(request).state).toBe('LIVE');
  });
  it('storage failure keeps the old coherent value and cut, then parks without a read', async () => {
    let fail = false;
    const lanes = new ReadLanes(identity, () => true, { write: async () => { if (fail) throw new Error('disk full'); },
      fence: async () => {}, remove: async () => {} });
    lanes.connected(1, [request.family], async () => snapshot());
    lanes.demand(request, {}, permit); await drain(); fail = true;
    await lanes.accept(batch(1, 2));
    expect(lanes.peek(request)).toMatchObject({ state: 'PARKED', value: { count: 1 }, cut: { through: 1 } });
  });
  it('interprets server logical Room removals through their exact certificate domain', async () => {
    const readerDomain = { authorityScope: 'reader:ada:workspace:w', epoch: '1' };
    const roomDomain = { authorityScope: 'room:room-a', epoch: '1' };
    const room = { family: 'room-head', roomId: 'room-a' } as const;
    const lanes = new ReadLanes(identity, () => true);
    lanes.connected(1, ['room-head', 'needs-you-count'], async input => ({ ...snapshot(),
      authority: { digest: 'certificate', scopes: input.family === 'room-head' ? [readerDomain, roomDomain] : [readerDomain] } }));
    lanes.demand(room, {}, permit); lanes.demand(request, {}, permit); await drain();
    await lanes.accept({ ...batch(1, 2), facts: [{ atomicGroup: 'room-authority',
      authority: { digest: 'certificate', scopes: [readerDomain, { ...roomDomain, epoch: '2' }] },
      payload: { kind: 'authority', scope: 'room-a', authorityScope: 'room:room-a', allowed: false } }] });
    expect(lanes.peek(room)).toMatchObject({ state: 'REVOKED', value: null });
    expect(lanes.peek(request)).toMatchObject({ state: 'LIVE', value: { count: 1 } });
  });
  it('interprets server Workspace removal without purging another Workspace', async () => {
    const lanes = new ReadLanes(identity, () => true);
    const other = { ...request, workspaceId: 'other' };
    lanes.connected(1, ['needs-you-count'], async input => ({ ...snapshot(),
      cut: { ...snapshot().cut, stream: `workspace:${input.workspaceId}` },
      authority: { digest: 'certificate', scopes: [{ authorityScope: `reader:ada:workspace:${input.workspaceId}`, epoch: '1' }] } }));
    lanes.demand(request, {}, permit); lanes.demand(other, {}, permit); await drain();
    await lanes.accept({ ...batch(1, 2), facts: [{ atomicGroup: 'workspace-authority',
      authority: { digest: 'certificate', scopes: [{ authorityScope: 'reader:ada:workspace:w', epoch: '2' }] },
      payload: { kind: 'authority', scope: 'w', authorityScope: 'reader:ada:workspace:w', allowed: false } }] });
    expect(lanes.peek(request)).toMatchObject({ state: 'REVOKED', value: null });
    expect(lanes.peek(other)).toMatchObject({ state: 'LIVE', value: { count: 1 } });
  });
  it('honors explicit Workspace denial even when the full certificate also contains an unchanged Room epoch', async () => {
    const room = { family: 'room-head', roomId: 'room-a', workspaceId: 'w' } as const;
    const lanes = new ReadLanes(identity, () => true);
    const reader = { authorityScope: 'reader:ada:workspace:w', epoch: '1' };
    const roomScope = { authorityScope: 'room:room-a', epoch: '1' };
    lanes.connected(1, ['room-head', 'needs-you-count'], async () => ({ ...snapshot(),
      authority: { digest: 'certificate', scopes: [reader, roomScope] } }));
    lanes.demand(room, {}, permit); lanes.demand(request, {}, permit); await drain();
    await lanes.accept({ ...batch(1, 2), facts: [{ atomicGroup: 'workspace-authority',
      authority: { digest: 'certificate', scopes: [{ ...reader, epoch: '2' }, roomScope] },
      payload: { kind: 'authority', scope: 'w', authorityScope: reader.authorityScope, allowed: false } }] });
    expect(lanes.peek(room)).toMatchObject({ state: 'REVOKED', value: null });
    expect(lanes.peek(request)).toMatchObject({ state: 'REVOKED', value: null });
  });
  it.each([undefined, 'reader:someone-else:workspace:w'])('fails closed for removal domain %s without purging unrelated Workspaces', async deniedDomain => {
    const lanes = new ReadLanes(identity, () => true);
    const other = { ...request, workspaceId: 'other' };
    lanes.connected(1, ['needs-you-count'], async input => ({ ...snapshot(),
      cut: { ...snapshot().cut, stream: `workspace:${input.workspaceId}` },
      authority: { digest: 'certificate', scopes: [{ authorityScope: `reader:ada:workspace:${input.workspaceId}`, epoch: '1' }] } }));
    lanes.demand(request, {}, permit); lanes.demand(other, {}, permit); await drain();
    await lanes.accept({ ...batch(1, 2), facts: [{ atomicGroup: 'invalid-authority', authority,
      payload: { kind: 'authority', scope: 'w', authorityScope: deniedDomain, allowed: false } }] });
    expect(lanes.peek(request)).toMatchObject({ state: 'PARKED', value: null });
    expect(lanes.peek(other)).toMatchObject({ state: 'LIVE', value: { count: 1 } });
  });
  it('retains a newer authorized grant and cut when an older removal arrives late', async () => {
    const lanes = new ReadLanes(identity, () => true);
    const currentAuthority = { digest: 'certificate', scopes: [{ authorityScope: 'reader:ada:workspace:w', epoch: '2' }] };
    lanes.connected(1, ['needs-you-count'], async () => ({ ...snapshot(3), authority: currentAuthority }));
    lanes.demand(request, {}, permit); await drain();
    await lanes.accept({ ...batch(0, 1), facts: [{ atomicGroup: 'old-authority',
      authority: { digest: 'certificate', scopes: [{ authorityScope: 'reader:ada:workspace:w', epoch: '1' }] },
      payload: { kind: 'authority', scope: 'w', authorityScope: 'reader:ada:workspace:w', allowed: false } }] });
    expect(lanes.peek(request)).toMatchObject({ state: 'LIVE', value: { count: 1 }, cut: { through: 3 } });
  });
  it('revocation purges data and late old authority cannot restore it', async () => {
    const lanes = setup(); lanes.demand(request, {}, permit); await drain();
    await lanes.accept({ ...batch(1, 2), facts: [{ atomicGroup: 'authority',
      authority: { ...authority, scopes: [{ authorityScope: 'reader:ada:workspace:w', epoch: '2' }] },
      payload: { kind: 'authority', scope: 'w', authorityScope: 'reader:ada:workspace:w', allowed: false } }] });
    await lanes.accept(batch(2, 3));
    expect(lanes.peek(request)).toMatchObject({ state: 'REVOKED', value: null });
  });
});

describe('precise minimum authority epochs without read admission',()=>{
  const visibility='reader:ada:workspace:w:visibility';
  const certified=(epoch:string,through=1):LaneSnapshot=>({...snapshot(through),authority:{digest:`certificate-${epoch}`,
    scopes:[...authority.scopes,{authorityScope:visibility,epoch}]}});
  const replacement=(epoch:string,from=1,to=2):LaneBatch=>({...batch(from,to),facts:[{atomicGroup:'needs:w:ada',authority:certified(epoch).authority,
    payload:{kind:'scope-replace',family:request.family,scope:'w',value:{count:to}}}]});
  it('hides stale aggregates, keeps an unrelated Room visible, and accepts equal-epoch facts without another read',async()=>{
    let reads=0;const room={family:'room-head',roomId:'room-a',workspaceId:'w'} as const;
    const lanes=new ReadLanes(identity,()=>true);
    lanes.connected(1,['needs-you-count','room-head'],async input=>{reads++;return input.family==='room-head'
      ?{...snapshot(),value:{room:'still allowed'},authority:{digest:'room',scopes:[...authority.scopes,{authorityScope:'room:room-a',epoch:'1'}]}}:certified('1');});
    lanes.demand(request,{},permit);lanes.demand(room,{},permit);await drain();
    await lanes.advance(visibility,'2');
    expect(lanes.peek(request)).toMatchObject({state:'OPENING',value:null,cut:{through:1}});
    expect(lanes.peek(room)).toMatchObject({state:'LIVE',value:{room:'still allowed'}});expect(reads).toBe(2);
    await lanes.accept(replacement('2'));
    expect(lanes.peek(request)).toMatchObject({state:'LIVE',value:{count:2},cut:{through:2}});
    await lanes.advance(visibility,'2');await lanes.advance(visibility,'1');
    expect(lanes.peek(request)).toMatchObject({state:'LIVE',value:{count:2}});expect(reads).toBe(2);
  });
  it('rejects an older late first snapshot while allowing a current first snapshot at the floor',async()=>{
    let resolve!:(value:LaneSnapshot)=>void,reads=0;
    const lanes=new ReadLanes(identity,()=>true);
    lanes.connected(1,[request.family],async()=>{reads++;return new Promise(done=>{resolve=done;});});
    lanes.demand(request,{},permit);await drain();await lanes.advance(visibility,'2');resolve(certified('1'));await drain();
    expect(lanes.peek(request)).toMatchObject({state:'PARKED',value:null});expect(reads).toBe(1);
    const current=new ReadLanes(identity,()=>true);await current.advance(visibility,'2',false);
    current.connected(1,[request.family],async()=>certified('2'));current.demand(request,{},permit);await drain();
    expect(current.peek(request)).toMatchObject({state:'LIVE',value:{count:1}});
  });
  it('does not advance coverage for an unrelated fact while awaiting an authoritative replacement',async()=>{
    const lanes=new ReadLanes(identity,()=>true);lanes.connected(1,[request.family],async()=>certified('1'));
    lanes.demand(request,{},permit);await drain();await lanes.advance(visibility,'2');
    await lanes.accept({...replacement('2'),facts:[]});
    expect(lanes.peek(request)).toMatchObject({value:null,cut:{through:1}});
    await lanes.accept(replacement('2',1,3));expect(lanes.peek(request)).toMatchObject({state:'LIVE',cut:{through:3}});
  });
  it('hides the whole count/cell group before notifying or waiting for durable floor storage',async()=>{
    let finish!:()=>void,stored=false;const persisted=new Promise<void>(done=>{finish=done;});
    const lanes=new ReadLanes(identity,()=>true,{write:async()=>{},fence:async()=>{},remove:async()=>{},
      floor:async()=>{await persisted;stored=true;}});
    const tray={family:'needs-you',workspaceId:'w'} as const;
    lanes.connected(1,['needs-you','needs-you-count'],async()=>certified('1'));
    lanes.demand(request,{},permit);lanes.demand(tray,{},permit);await drain();
    let observing=false;const observed:unknown[][]=[];
    lanes.subscribe(request,()=>{if(observing)observed.push([lanes.peek(request).value,lanes.peek(tray).value]);});
    lanes.subscribe(tray,()=>{if(observing)observed.push([lanes.peek(request).value,lanes.peek(tray).value]);});
    observing=true;const pending=lanes.advance(visibility,'2');
    expect(observed).toEqual([[null,null],[null,null]]);expect(stored).toBe(false);
    finish();await pending;expect(stored).toBe(true);
  });
  it('cannot paint a stale snapshot whose asynchronous storage write completes after the floor',async()=>{
    let started!:()=>void,finish!:()=>void;const writing=new Promise<void>(done=>{started=done;});
    const released=new Promise<void>(done=>{finish=done;});let reads=0;
    const lanes=new ReadLanes(identity,()=>true,{write:async()=>{started();await released;},floor:async()=>{},fence:async()=>{},remove:async()=>{}});
    lanes.connected(1,[request.family],async()=>{reads++;return certified('1');});lanes.demand(request,{},permit);
    await writing;await lanes.advance(visibility,'2');finish();await drain();
    expect(lanes.peek(request)).toMatchObject({state:'PARKED',value:null});expect(reads).toBe(1);
  });
});

describe('complete logical batch staging', () => {
  it('does not paint partial batches; commit, all parts and digest are required', () => {
    const committed: LaneBatch[] = []; const faults: string[] = [];
    const assembly = new RouterBatchAssembly(facts => facts.length ? 'digest' : 'empty', value => committed.push(value), stream => faults.push(stream));
    const facts = batch(1, 2).facts;
    const part: RouterPart = { kind: 'push-part', batchId: 'batch', ...batch(1, 2), partIndex: 0, partCount: 2,
      contentDigest: 'digest', facts: [] };
    assembly.accept(part);
    assembly.accept({ kind: 'push-commit', batchId: part.batchId, from: part.from, to: part.to,
      partCount: 2, contentDigest: part.contentDigest });
    expect(committed).toHaveLength(0);
    assembly.accept({ ...part, partIndex: 1, facts });
    expect(committed).toHaveLength(1);
    assembly.accept({ ...part, partIndex: 1, facts });
    expect(committed).toHaveLength(1);
    expect(faults).toEqual([]);
  });
  it('conflicting duplicate or oversized staging parks only its stream', () => {
    const faults: string[] = [];
    const assembly = new RouterBatchAssembly(() => 'digest', () => {}, stream => faults.push(stream));
    const part: RouterPart = { kind: 'push-part', batchId: 'batch', ...batch(1, 2), partIndex: 0, partCount: 2,
      contentDigest: 'digest' };
    assembly.accept(part); assembly.accept({ ...part, facts: [] });
    expect(faults).toEqual(['workspace:w']);
  });
});

describe('real navigation residencies', () => {
  it('joins effect replay but A to B to A creates a fresh generation', () => {
    const owner = new NavigationOwner();
    const a = { index: 0, routes: [{ key: 'a', name: 'beeline/chat/[channelId]', params: { channelId: 'room-a' } }] };
    owner.observe(a); const first = owner.current(); owner.observe(a);
    expect(owner.current()).toBe(first);
    owner.observe({ index: 0, routes: [{ key: 'b', name: 'beeline/channels' }] });
    owner.observe(a); expect(owner.current()!.generation).toBeGreaterThan(first!.generation);
  });
  it('background revokes visibility, foreground does not manufacture another focus', () => {
    const owner = new NavigationOwner();
    const state = { routes: [{ key: 'a', name: 'beeline/channels' }] };
    owner.observe(state); const first = owner.current();
    owner.background(); expect(owner.current()).toBeUndefined();
    owner.foregrounded(); owner.observe(state); expect(owner.current()).toBe(first);
  });
});
