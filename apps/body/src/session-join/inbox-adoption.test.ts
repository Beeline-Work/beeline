import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {queueInbox,queueInboxOnce,takeInbox} from './store.js';
const roots:string[]=[];
const key='codex:/synthetic/project';
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'beeline-inbox-adoption-'));roots.push(dir);
  mkdirSync(join(dir,'inbox'));
  const stem=createHash('sha256').update(key).digest('hex').slice(0,24);
  return {dir,path:join(dir,'inbox',stem+'.txt'),folder:join(dir,'deliveries',stem)};
}
afterEach(()=>{vi.restoreAllMocks();for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});
describe('one joined-session delivery format across upgrade',()=>{
  it('adopts pending installed-helper text before streamed deliveries without losing either',()=>{
    const {dir,path}=fixture();writeFileSync(path,'old pending one\n\nold pending two');
    queueInboxOnce(dir,key,'stream:one','new committed message');
    expect(takeInbox(dir,key)).toBe('old pending one\n\nold pending two\n\nnew committed message');
    expect(existsSync(path)).toBe(false);expect(existsSync(path+'.adopting')).toBe(false);
    expect(takeInbox(dir,key)).toBe('');
    expect(queueInboxOnce(dir,key,'stream:one','must not repeat')).toBe(false);
  });
  it('consumes an atomically adopted text file after restart through the usual delivery claim',()=>{
    const {dir,path,folder}=fixture();writeFileSync(path,'recover once');mkdirSync(folder,{recursive:true});
    renameSync(path,join(folder,'interrupted.text.pending'));
    expect(takeInbox(dir,key)).toBe('recover once');expect(takeInbox(dir,key)).toBe('');
    expect(readdirSync(folder)).toEqual(['interrupted.text.done']);
  });
  it('writes local messages only to the delivery queue and preserves same-millisecond order',()=>{
    const {dir,path,folder}=fixture();vi.spyOn(Date,'now').mockReturnValue(1_800_000_000_000);
    queueInbox(dir,key,'one');queueInbox(dir,key,'two');queueInbox(dir,key,'three');
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(folder).filter(name=>name.endsWith('.pending'))).toHaveLength(3);
    expect(takeInbox(dir,key)).toBe('one\n\ntwo\n\nthree');expect(takeInbox(dir,key)).toBe('');
  });
});
