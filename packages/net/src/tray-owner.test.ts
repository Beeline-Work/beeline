import {describe,it,expect} from 'vitest';
import {AdmissionOwner,validateTrayProjection} from './private/phone-owner.js';
import {NavigationOwner} from './private/navigation-owner.js';
const identity={origin:'https://example.test',principal:'ada',sessionEpoch:1};
const request={route:'phone.readRouterSnapshot',input:{family:'needs-you-tray',workspaceId:'workspace-a'}} as const;
describe('complete Tray ownership',()=>{
  it('requires actual Tray residency and leaves count-only AppShell ownership separate',()=>{
    const navigation=new NavigationOwner();
    navigation.observe({routes:[{key:'tray',name:'beeline/tray',params:{communityId:'workspace-a'}}]});
    expect(navigation.current()).toMatchObject({screen:'Tray',workspaceId:'workspace-a'});
    const owner=new AdmissionOwner(identity);
    expect(()=>owner.focusOwner('badge',1,'AppShell',[request])).toThrow('wrong screen family');
    const [pass]=owner.focusOwner('tray',1,'Tray',[request]);
    const wire=owner.spend(request,pass!).wire;
    expect(wire).toEqual({operation:'readRouterSnapshot',input:'{"family":"needs-you-tray","workspaceId":"workspace-a"}'});
    expect(()=>owner.spend(request,pass!)).toThrow('inactive pass');
    navigation.observe({routes:[{key:'rooms',name:'beeline/channels'}]});
    expect(navigation.current()?.screen).toBe('AppShell');
  });
  it('admits a continuation only inside a focused Saved gesture and fences completion on blur',()=>{
    const owner=new AdmissionOwner(identity),before='saved1.Y3Vyc29y';
    const next={route:'phone.readRouterSnapshot' as const,input:{family:'needs-you-saved-page' as const,workspaceId:'workspace-a',before}};
    expect(()=>owner.continueSaved(1,'workspace-a',before,()=>undefined)).toThrow('inactive Saved action');
    owner.focusOwner('tray',1,'Tray',[request]);
    const admitted=owner.continueSaved(1,'workspace-a',before,pass=>owner.spend(next,pass));
    expect(JSON.parse(admitted.wire.input)).toEqual(next.input);expect(admitted.isCurrent()).toBe(true);
    const leaked=owner.continueSaved(1,'workspace-a',before,pass=>pass);
    expect(()=>owner.spend(next,leaked)).toThrow('inactive pass');
    expect(()=>owner.continueSaved(1,'other',before,()=>undefined)).toThrow('inactive Saved action');
    owner.releaseOwner('tray');expect(admitted.isCurrent()).toBe(false);
  });
  it('spends painted questions once per actual residency and never admits paint as a tap',()=>{
    const owner=new AdmissionOwner(identity);
    expect(()=>owner.paintTray(1,'workspace-a',['q'])).toThrow('inactive paint owner');
    owner.focusOwner('tray',1,'Tray',[request]);
    const admitted=owner.paintTray(1,'workspace-a',['q','q']);
    expect(JSON.parse(admitted!.wire.input)).toEqual({workspaceId:'workspace-a',messageIds:['q']});
    expect(owner.paintTray(1,'workspace-a',['q'])).toBeUndefined();
    expect(()=>owner.paintTray(1,'workspace-a',Array.from({length:31},(_,i)=>String(i)))).toThrow('paint quota');
    owner.releaseOwner('tray');
    expect(()=>owner.paintTray(1,'workspace-a',['r'])).toThrow('inactive paint owner');
    owner.resumeObservation('tray',1);
    expect(owner.paintTray(1,'workspace-a',['q'])).toBeUndefined();
    owner.focusOwner('tray',2,'Tray',[request]);
    expect(owner.paintTray(2,'workspace-a',['q'])).toBeDefined();
  });
  it('bounds residency dedup memory without forgetting and resending earlier painted IDs',()=>{
    const owner=new AdmissionOwner(identity);owner.focusOwner('tray',1,'Tray',[request]);
    const first=Array.from({length:30},(_,i)=>String(i)+'x'.repeat(1800));
    expect(owner.paintTray(1,'workspace-a',first)).toBeDefined();
    expect(()=>owner.paintTray(1,'workspace-a',first.map(id=>'other'+id))).toThrow('paint residency capacity');
    expect(owner.paintTray(1,'workspace-a',first)).toBeUndefined();
  });
  it('admits the declared command action and rejects mismatched or fabricated actions',()=>{
    const owner=new AdmissionOwner(identity);
    const stop={route:'phone.deleteRoomSchedule',input:{roomId:'r',scheduleId:'s'}} as const;
    const stopped=owner.tap('StopScheduledWork',stop,pass=>owner.spend(stop,pass));
    expect(stopped.wire.operation).toBe('deleteRoomSchedule');
    expect(stopped.isCurrent()).toBe(true);
    expect(()=>owner.tap('EditTray' as never,stop,()=>undefined)).toThrow('wrong action');
    const paint={route:'phone.markNeedsYouSeen',input:{workspaceId:'workspace-a',messageIds:['q']}} as const;
    expect(()=>owner.tap('PaintTray' as never,paint as never,()=>undefined)).toThrow('wrong action');
  });
  it('accepts complete canonical sections beyond former display row and byte caps',()=>{
    const items=Array.from({length:31},(_,n)=>({messageId:`q${n}`,roomId:'room',workspaceId:'workspace-a',
      roomName:'Room',roomKind:'room',text:n===0?'x'.repeat(128*1024):'Question',createdAt:1}));
    const saved={windowId:`saved1:${'a'.repeat(64)}`,rows:[]};
    expect(validateTrayProjection({needs:{items},saved},'workspace-a')).toBe(true);
    expect(validateTrayProjection({needs:{items:[...items,{...items[0],createdAt:'invalid'}]},saved},'workspace-a')).toBe(false);
  });
  it('requires both validated sections; legacy partial/error envelopes cannot become canonical data',()=>{
    expect(validateTrayProjection({needs:{items:[]},saved:{windowId:`saved1:${'a'.repeat(64)}`,rows:[]}},'workspace-a')).toBe(true);
    for(const value of [{},{needs:{items:[]},saved:{windowId:`saved1:${'a'.repeat(64)}`,rows:[]},undeclared:true},{needs:{items:[]}},{saved:{bookmarks:[]}},
      {needs:{items:[]},saved:{bookmarks:[]},savedError:'unavailable'},
      {needs:{items:[]},saved:{bookmarks:[{messageId:'unvalidated'}]}}])expect(validateTrayProjection(value,'workspace-a')).toBe(false);
  });
});
