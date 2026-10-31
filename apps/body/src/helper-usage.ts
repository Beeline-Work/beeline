/** Host-only observations: never used as deletion or process-kill authority. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { readStorageOwners } from './storage-owners.js';
import type { StorageReclaimEntry, StorageRoomState } from './helper-storage.js';

const exec = promisify(execFile);
const DISK_INTERVAL_MS = 6 * 60 * 60_000;

// Stream metadata, not file contents. O_NOATIME prevents measuring retention
// candidates from resetting their idle clock. Never follow symlinks or mounts.
const INVENTORY = String.raw`
import os,sys,stat,json
root=sys.argv[1]; mode=sys.argv[2]; totals={}; errors=0
if mode=='disk':
 seen=set(); device=os.lstat(root).st_dev
 def visit(path,category,kind):
  global errors
  try:
   s=os.lstat(path)
   if s.st_dev!=device: return
   key=(s.st_dev,s.st_ino)
   if key in seen: return
   seen.add(key)
   name=os.path.basename(path)
   if name=='node_modules': kind='dependencies'
   elif name=='.codegraph': kind='codegraph'
   elif name in ['tmp','attachments','logs','android-instances']: kind=name
   bucket=category+':'+kind
   item=totals.setdefault(bucket,{'allocatedBytes':0,'entries':0})
   item['allocatedBytes']+=s.st_blocks*512; item['entries']+=1
   if stat.S_ISDIR(s.st_mode):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NOATIME)
    try: names=os.listdir(fd)
    finally: os.close(fd)
    for name in names: visit(os.path.join(path,name),category,kind)
  except OSError: errors+=1
 fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NOATIME)
 try: names=os.listdir(fd)
 finally: os.close(fd)
 for name in sorted(names): visit(os.path.join(root,name),name,'other')
else:
 rows={}; owner=int(sys.argv[3])
 for pid in os.listdir('/proc'):
  if not pid.isdigit(): continue
  try:
   p='/proc/'+pid
   if os.stat(p).st_uid!=os.getuid(): continue
   with open(p+'/status') as f: status=dict(line.split(':',1) for line in f if ':' in line)
   with open(p+'/cmdline','rb') as f: args=f.read().decode(errors='replace').split('\0')
   cwd=os.readlink(p+'/cwd'); exe=os.readlink(p+'/exe')
   rows[int(pid)]=(int(status['PPid']),int(status.get('VmRSS','0 kB').split()[0])*1024,args,cwd,exe)
  except (OSError,ValueError): errors+=1
 def descendant(pid):
  seen=set()
  while pid in rows and pid not in seen:
   if pid==owner: return True
   seen.add(pid); pid=rows[pid][0]
  return False
 for pid,(_,rss,args,cwd,exe) in rows.items():
  # Include detached work rooted in helper state, but not arbitrary same-user work.
  owned=descendant(pid) or cwd.startswith(root+'/') or any(a.startswith(root+'/') for a in args)
  if not owned: continue
  text=' '.join(args)
  category=('helper' if pid==owner else 'emulator' if 'qemu-system' in exe else
   'codegraph' if '/codegraph/' in exe else 'browser' if any(x in os.path.basename(exe) for x in ['chrome','chromium']) else
   'harness' if any(x in os.path.basename(exe) for x in ['codex','claude']) else 'other')
  item=totals.setdefault(category,{'rssBytes':0,'count':0}); item['rssBytes']+=rss; item['count']+=1
print(json.dumps({'categories':totals,'errors':errors}))
`;

export async function sampleHelperUsage(root: string, mode: 'disk' | 'process', signal?: AbortSignal): Promise<unknown> {
  const { stdout } = await exec('/usr/bin/python3', ['-c', INVENTORY, root, mode, String(process.pid)], {
    timeout: mode === 'disk' ? 10 * 60_000 : 30_000, maxBuffer: 1024 * 1024, signal,
  });
  return JSON.parse(stdout);
}

/** Missing lifecycle evidence is unknown, never proof that a folder is orphaned. */
export async function countCornerFolders(supervisorRoot: string, states: ReadonlyMap<string, boolean>) {
  const counts = { open: 0, orphaned: 0, unknown: 0 };
  const owners = new Map((await readStorageOwners(supervisorRoot))
    .filter(owner => owner.kind === 'corners').map(owner => [owner.itemId, owner]));
  const folders = await readdir(resolve(supervisorRoot, 'beeline/corners'), { withFileTypes: true });
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const owner = owners.get(folder.name);
    const archived = states.get(owner?.roomId ?? folder.name);
    if (owner?.ended || archived === true) counts.orphaned++;
    else if (archived === false) counts.open++;
    else counts.unknown++;
  }
  return counts;
}

/** A disk scan never overlaps another; failures retry only at the next six-hour window. */
export function monitorHelperUsage(supervisorRoot: string): {
  cleanup: (entry: StorageReclaimEntry) => void;
  observe: (states: readonly StorageRoomState[]) => void;
  stop: () => void;
} {
  const controller = new AbortController();
  const root = resolve(supervisorRoot, 'beeline');
  const lifecycle = new Map<string, boolean>();
  let disk: unknown = null, diskAt: number | null = null, diskError = false;
  let nextDiskAt = 0, scanning = false, sampling = false;
  let cleanupActions = 0, freedBytes = 0;
  const tick = async () => {
    if (sampling || controller.signal.aborted) return;
    sampling = true;
    if (!scanning && Date.now() >= nextDiskAt) {
      scanning = true;
      nextDiskAt = Date.now() + DISK_INTERVAL_MS;
      void sampleHelperUsage(root, 'disk', controller.signal).then(value => {
        disk = value; diskAt = Date.now(); diskError = false;
      }, () => { diskError = true; }).finally(() => { scanning = false; });
    }
    try {
      const processes = await sampleHelperUsage(root, 'process', controller.signal);
      const cornerFolders = await countCornerFolders(supervisorRoot, lifecycle).catch(() => null);
      if (!controller.signal.aborted) console.log('[helper] usage ' + JSON.stringify({
        version: 1, at: Date.now(), diskAt, disk, diskError, diskScanning: scanning,
        processes, cornerFolders, cleanupActions, freedBytes,
      }));
    } catch {
      if (!controller.signal.aborted) console.warn('[helper] usage process sample unavailable');
    } finally { sampling = false; }
  };
  const timer = setInterval(() => { void tick(); }, 5 * 60_000);
  timer.unref();
  void tick();
  return {
    cleanup: entry => { cleanupActions++; freedBytes += entry.freedBytes; },
    observe: states => {
      for (const state of states) {
        if (lifecycle.get(state.roomId) !== true) lifecycle.set(state.roomId, state.archived);
      }
    },
    stop: () => { clearInterval(timer); controller.abort(); },
  };
}
