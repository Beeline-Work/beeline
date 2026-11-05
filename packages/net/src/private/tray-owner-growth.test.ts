import {describe,it,expect} from 'vitest';
import {AdmissionOwner,validateTrayProjection} from './phone-owner.js';
import {NavigationOwner} from './navigation-owner.js';
const identity={origin:'https://example.test',principal:'ada',sessionEpoch:1};
const request={route:'phone.readRouterSnapshot',input:{family:'needs-you-tray',workspaceId:'workspace-a'}} as const;
describe('phone growth and recovery', () => {
  it('spends painted questions once per actual residency and never admits paint as a tap',()=>{
    const owner=new AdmissionOwner(identity);
    expect(()=>owner.paintTray(1,'workspace-a',['q'])).toThrow('inactive paint owner');
    owner.focusOwner('tray',1,'Tray',[request]);
    const admitted=owner.paintTray(1,'workspace-a',['q','q']);
    expect(JSON.parse(admitted!.wire.input)).toEqual({workspaceId:'workspace-a',messageIds:['q']});
    expect(owner.paintTray(1,'workspace-a',['q'])).toBeUndefined();
    expect(owner.paintTray(1,'workspace-a',Array.from({length:31},(_,i)=>String(i)))).toBeDefined();
    owner.releaseOwner('tray');
    expect(()=>owner.paintTray(1,'workspace-a',['r'])).toThrow('inactive paint owner');
    owner.resumeObservation('tray',1);
    expect(owner.paintTray(1,'workspace-a',['q'])).toBeUndefined();
    owner.focusOwner('tray',2,'Tray',[request]);
    expect(owner.paintTray(2,'workspace-a',['q'])).toBeDefined();
  });
  it('evicts old paint dedup history while admitting later idempotent seen marks',()=>{
    const owner=new AdmissionOwner(identity);owner.focusOwner('tray',1,'Tray',[request]);
    const first=Array.from({length:30},(_,i)=>String(i)+'x'.repeat(1800));
    expect(owner.paintTray(1,'workspace-a',first)).toBeDefined();
    for(let i=1;i<64;i++)expect(owner.paintTray(1,'workspace-a',first.map(id=>String(i)+id))).toBeDefined();
    expect(owner.paintTray(1,'workspace-a',first)).toBeDefined();
  });
});
