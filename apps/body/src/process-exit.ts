import { spawn } from 'node:child_process';

// pidfd/kqueue are kernel exit notifications, with no polling or timeout.
const WAIT = `import os,sys,select
pid=int(sys.argv[1])
try:
 if hasattr(os,'pidfd_open'):
  fd=os.pidfd_open(pid)
  try: select.select([fd],[],[])
  finally: os.close(fd)
 else:
  queue=select.kqueue()
  try: queue.control([select.kevent(pid,filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT,fflags=select.KQ_NOTE_EXIT)],1)
  finally: queue.close()
except ProcessLookupError: pass
`;
export function waitForProcessExit(pid:number,signal?:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/python3',['-c',WAIT,String(pid)],{stdio:'ignore',signal});
    child.once('error',reject);
    child.once('close',code=>code===0?resolve():reject(new Error(`process exit observer failed (${code})`)));
  });
}
