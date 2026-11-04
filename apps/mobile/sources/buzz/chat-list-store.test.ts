import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ChatListView} from '@beeline/api-contract/phone';
import type {RouterSnapshot} from '@beeline/api-contract/router-protocol';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex,utf8ToBytes} from '@noble/hashes/utils.js';
const storage=vi.hoisted(()=>({floor:vi.fn(async()=>{}),subscribeFloors:()=>()=>{},write:vi.fn(async()=>{}),
  fence:vi.fn(async()=>{}),remove:vi.fn(async()=>{}),subscribeFences:()=>()=>{}}));
vi.mock('react-native',()=>({AppState:{currentState:'active',addEventListener:()=>({remove(){}})}}));
vi.mock('@/auth/buzz-identity-storage',()=>({loadBuzzIdentity:async()=>({publicKey:'ada'}),getEffectiveRelayUrl:async()=> 'https://example.test'}));
vi.mock('./surface-storage',()=>({routerLaneStorage:()=>storage,routerAuthorityStorageReady:()=>true,routerCommandStorageReady:()=>true}));
vi.mock('./router-family',()=>({holdRouterConnection:()=>()=>{},useRouterFamily:()=> 'router'}));
import {acquireChatList,chatListSnapshot,liveChatList,type ChatListHandle} from './chat-list-store';
import {resetClientState} from '@/sync/client-reset';
import {routerOwnerNavigation,routerOwnerNegotiated,routerOwnerReceive,routerOwnerDisconnected} from './router-owner';
const workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const key={workspaceId:workspace,relayUrl:'https://example.test',viewerPubkey:'ada'};
const hash=(value:unknown)=>bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
const scopes=[{authorityScope:`reader:ada:workspace:${workspace}`,epoch:'1'},
  {authorityScope:`reader:ada:workspace:${workspace}:visibility`,epoch:'1'}];
const authority={scopes,digest:hash(scopes)};
const view=(unread=false):ChatListView=>({workspace:{id:workspace,name:'Synthetic',role:'member',updatedAt:1},
  viewer:{pubkey:'a'.repeat(64),kind:'human',name:'Reader'},truncated:false,watchFilters:[],
  chats:[{room:{id:room,workspaceId:workspace,name:'Room',archived:false,createdAt:1,updatedAt:1},unread}]});
const snapshot=(value=view(),through=1):RouterSnapshot<'room-list'>=>({kind:'snapshot',family:'room-list',scope:workspace,value,
  cut:{stream:`workspace:${workspace}`,epoch:'stream',protocol:1,through},authority,atomicGroup:`room-list:${workspace}:ada`});
const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const handles:ChatListHandle[]=[];
function observe(visible=()=>true){const handle=acquireChatList(key,{visible});handles.push(handle);return handle;}
function navigate(){routerOwnerNavigation({routes:[{key:'rooms',name:'beeline/channels',params:{communityId:workspace}}]});}
async function connect(execute=vi.fn(async()=>snapshot()),generation=1){await routerOwnerNegotiated({generation,families:['room-list'],authorityFencesV1:true,execute});await settle();return execute;}
beforeEach(()=>{resetClientState();vi.clearAllMocks();});
afterEach(()=>{for(const handle of handles.splice(0))handle.release();resetClientState();});
describe('Room list consumes the single canonical router lane',()=>{
  it('mounting alone reads nothing; two navigated consumers share one snapshot',async()=>{
    const first=observe(),second=observe();const execute=await connect();
    expect(execute).not.toHaveBeenCalled();expect(first.current()).toBeNull();navigate();await settle();
    expect(execute).toHaveBeenCalledTimes(1);expect(first.current()).toEqual(view());expect(second.current()).toEqual(view());
    first.release();expect(second.confirmed()).toBe(true);
  });
  it('hiding and revealing an observer cannot create an extra covering read',async()=>{
    let visible=false;const handle=observe(()=>visible);navigate();const execute=await connect();
    expect(execute).not.toHaveBeenCalled();visible=true;handle.catchUp();await settle();
    expect(execute).toHaveBeenCalledTimes(1);handle.force();handle.catchUp();await settle();expect(execute).toHaveBeenCalledTimes(1);
  });
  it('renders server ordering and unread facts as committed, with no post-fact read or client reduction',async()=>{
    const handle=observe();navigate();const execute=await connect();
    const original=view(true);const value={...original,chats:original.chats.map(item=>({...item,room:{...item.room,name:'Server-renamed Room'}}))};
    const facts=[{atomicGroup:snapshot().atomicGroup,authority,payload:{kind:'scope-replace',family:'room-list',scope:workspace,value}}];
    const batch={batchId:'committed-list',from:snapshot().cut,to:snapshot(value,2).cut,partCount:1,contentDigest:hash(facts)};
    routerOwnerReceive({...batch,kind:'push-commit'});routerOwnerReceive({...batch,kind:'push-part',partIndex:0,facts});await settle();
    expect(handle.current()).toEqual(value);expect(liveChatList(key)).toEqual(value);expect(chatListSnapshot(key)).toEqual(value);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('cannot restore a stored or held list on an incapable replacement',async()=>{
    const handle=observe();navigate();const execute=await connect();expect(handle.current()).toEqual(view());
    routerOwnerDisconnected();expect(handle.current()).toBeNull();expect(chatListSnapshot(key)).toBeNull();
    await routerOwnerNegotiated({generation:2,families:[],execute});await settle();
    handle.force();handle.catchUp();await settle();expect(handle.current()).toBeNull();expect(execute).toHaveBeenCalledTimes(1);
  });
  it('a prior identity response cannot populate the replacement reader',async()=>{
    let resolve!:(value:RouterSnapshot<'room-list'>)=>void;
    const execute=vi.fn(()=>new Promise<RouterSnapshot<'room-list'>>(done=>{resolve=done;}));
    const handle=observe();navigate();await connect(execute);expect(execute).toHaveBeenCalledTimes(1);
    resetClientState();resolve(snapshot());await settle();expect(handle.current()).toBeNull();expect(chatListSnapshot(key)).toBeNull();
  });
});
