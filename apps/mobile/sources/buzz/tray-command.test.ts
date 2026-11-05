import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({owner:undefined as any}));
vi.mock('./command-owner',()=>({activeCommandOwner:()=>state.owner,canonical:JSON.stringify}));
import {prepareTrayCommand} from './tray-command';
beforeEach(()=>{state.owner=undefined;});
it('keeps the existing plain write when durable storage is unavailable',()=>{
  expect(prepareTrayCommand({operation:'clearNeedsYouSection',input:{workspaceId:'workspace'}})).toBeUndefined();
});
it('persists the gesture bytes and delivers their same identity once after Undo expires',async()=>{
  let finish!:(value:{id:string})=>void;
  state.owner={canPrepare:()=>true,prepare:vi.fn(()=>new Promise(resolve=>{finish=resolve;})),deliver:vi.fn(),cancel:vi.fn()};
  const input={workspaceId:'workspace'},command=prepareTrayCommand({operation:'clearNeedsYouSection',input})!;
  input.workspaceId='another';expect(state.owner.prepare.mock.calls[0][0].wire.input).toBe('{"workspaceId":"workspace"}');
  const delivery=command.deliver();expect(state.owner.deliver).not.toHaveBeenCalled();finish({id:'immutable'});
  await delivery;await command.deliver();expect(state.owner.deliver).toHaveBeenCalledExactlyOnceWith('immutable');
});
it('Undo cancels the prepared identity before any send',async()=>{
  state.owner={canPrepare:()=>true,prepare:vi.fn(async()=>({id:'held'})),deliver:vi.fn(),cancel:vi.fn()};
  const command=prepareTrayCommand({operation:'clearMessageBookmarks',input:{workspaceId:'workspace'}})!;
  await command.cancel();await command.deliver();expect(state.owner.cancel).toHaveBeenCalledWith('held');expect(state.owner.deliver).not.toHaveBeenCalled();
});
