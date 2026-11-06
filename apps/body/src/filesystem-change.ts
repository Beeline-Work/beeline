import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Subscribe before inspecting: a lock released between the failed acquire
 * and this wait is already absent. Only filesystem changes wake the waiter. */
export function waitForPathRemoval(path:string):Promise<void>{
  return new Promise((resolve,reject)=>{
    let reading=false,dirty=false,ended=false;
    const finish=(error?:unknown)=>{if(ended)return;ended=true;watcher.close();if(error)reject(error);else resolve();};
    const inspect=async()=>{
      dirty=true;if(reading||ended)return;reading=true;
      try{do{dirty=false;const present=await stat(path).then(()=>true,error=>{
        if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;
      });if(!present){finish();return;}}while(dirty&&!ended);}catch(error){finish(error);}finally{reading=false;}
    };
    const watcher=watch(dirname(path),()=>{void inspect();});
    watcher.once('error',finish);void inspect();
  });
}
