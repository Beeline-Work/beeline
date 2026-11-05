
import {afterEach as move4_afterEach,describe as move4_describe,expect as move4_expect,it as move4_it,vi as move4_vi} from 'vitest';

import {createHash as move4_createHash} from 'node:crypto';

import {existsSync as move4_existsSync,mkdirSync as move4_mkdirSync,mkdtempSync as move4_mkdtempSync,readdirSync as move4_readdirSync,renameSync as move4_renameSync,rmSync as move4_rmSync,writeFileSync as move4_writeFileSync} from 'node:fs';

import {tmpdir as move4_tmpdir} from 'node:os';

import {join as move4_join} from 'node:path';

import {queueInbox as move4_queueInbox,queueInboxOnce as move4_queueInboxOnce,takeInbox as move4_takeInbox} from "./store.js";
import { describe as movedDescribe4 } from 'vitest';
movedDescribe4("inbox-adoption.test.ts", () => {

const roots:string[]=[];

const key='codex:/synthetic/project';

function fixture(){
  const dir=move4_mkdtempSync(move4_join(move4_tmpdir(),'beeline-inbox-adoption-'));roots.push(dir);
  move4_mkdirSync(move4_join(dir,'inbox'));
  const stem=move4_createHash('sha256').update(key).digest('hex').slice(0,24);
  return {dir,path:move4_join(dir,'inbox',stem+'.txt'),folder:move4_join(dir,'deliveries',stem)};
}

move4_afterEach(()=>{move4_vi.restoreAllMocks();for(const dir of roots.splice(0))move4_rmSync(dir,{recursive:true,force:true});});

move4_describe('one joined-session delivery format across upgrade',()=>{
  move4_it('adopts pending installed-helper text before streamed deliveries without losing either',()=>{
    const {dir,path}=fixture();move4_writeFileSync(path,'old pending one\n\nold pending two');
    move4_queueInboxOnce(dir,key,'stream:one','new committed message');
    move4_expect(move4_takeInbox(dir,key)).toBe('old pending one\n\nold pending two\n\nnew committed message');
    move4_expect(move4_existsSync(path)).toBe(false);move4_expect(move4_existsSync(path+'.adopting')).toBe(false);
    move4_expect(move4_takeInbox(dir,key)).toBe('');
    move4_expect(move4_queueInboxOnce(dir,key,'stream:one','must not repeat')).toBe(false);
  });
  move4_it('consumes an atomically adopted text file after restart through the usual delivery claim',()=>{
    const {dir,path,folder}=fixture();move4_writeFileSync(path,'recover once');move4_mkdirSync(folder,{recursive:true});
    move4_renameSync(path,move4_join(folder,'interrupted.text.pending'));
    move4_expect(move4_takeInbox(dir,key)).toBe('recover once');move4_expect(move4_takeInbox(dir,key)).toBe('');
    move4_expect(move4_readdirSync(folder)).toEqual(['interrupted.text.done']);
  });
  move4_it('writes local messages only to the delivery queue and preserves same-millisecond order',()=>{
    const {dir,path,folder}=fixture();move4_vi.spyOn(Date,'now').mockReturnValue(1_800_000_000_000);
    move4_queueInbox(dir,key,'one');move4_queueInbox(dir,key,'two');move4_queueInbox(dir,key,'three');
    move4_expect(move4_existsSync(path)).toBe(false);
    move4_expect(move4_readdirSync(folder).filter(name=>name.endsWith('.pending'))).toHaveLength(3);
    move4_expect(move4_takeInbox(dir,key)).toBe('one\n\ntwo\n\nthree');move4_expect(move4_takeInbox(dir,key)).toBe('');
  });
});
});
