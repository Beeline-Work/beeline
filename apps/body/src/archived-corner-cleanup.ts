/** Destructive cleanup is called only with a persisted server-confirmed archive fact. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ordinaryDirectory, storageTree, hasMount, type WholeStorageOptions, type StorageReclaimEntry } from './helper-storage.js';
import { stopKeptCornerEmulator } from './corner-emulator.js';
const exec = promisify(execFile);

// pidfds fence PID reuse. No environment values, arbitrary shell commands or
// process-group signals. Attribution requires a cwd or an absolute argument
// within an exact closed-corner root. The helper and its ancestors are excluded.
const STOP = String.raw`
import os,sys,json,signal,time
roots=json.loads(sys.argv[1]); helper=int(sys.argv[2]); rows={}
def inside(p): return any(p==r or p.startswith(r+'/') for r in roots)
for name in os.listdir('/proc'):
 if not name.isdigit(): continue
 pid=int(name)
 try:
  base='/proc/'+name
  if os.stat(base).st_uid!=os.getuid(): continue
  with open(base+'/stat') as f: parts=f.read().rsplit(')',1)[1].split()
  with open(base+'/cmdline','rb') as f: args=f.read().decode(errors='replace').split('\0')
  cwd=os.readlink(base+'/cwd'); exe=os.readlink(base+'/exe')
  rows[pid]=(int(parts[1]),parts[19],cwd,args,exe)
 except (OSError,ValueError): continue
protected={os.getpid(),helper}; p=helper
while p in rows and rows[p][0] not in protected:
 p=rows[p][0]; protected.add(p)
brokers={pid for pid,(_,_,_,args,exe) in rows.items() if 'trusty-squire' in exe or any('trusty-squire' in a for a in args[:2])}
changed=True
while changed:
 changed=False
 for pid,(parent,_,_,_,_) in rows.items():
  if parent in brokers and pid not in brokers: brokers.add(pid); changed=True
protected.update(brokers)
selected=set()
for pid,(_,_,cwd,args,exe) in rows.items():
 if pid in protected or 'trusty-squire' in exe or any('trusty-squire' in a for a in args[:2]): continue
 if inside(cwd) or any(inside(a.partition('=')[2] if a.startswith('--') and '=' in a else a) for a in args): selected.add(pid)
# Descendants belong to the attributed process, unless explicitly protected.
changed=True
while changed:
 changed=False
 for pid,(parent,_,_,args,exe) in rows.items():
  if parent in selected and pid not in selected and pid not in protected and 'trusty-squire' not in exe and not any('trusty-squire' in a for a in args[:2]):
   selected.add(pid); changed=True
fds=[]
try:
 for pid in selected:
  try:
   fd=os.pidfd_open(pid)
   with open('/proc/'+str(pid)+'/stat') as f: start=f.read().rsplit(')',1)[1].split()[19]
   if start!=rows[pid][1]: os.close(fd); continue
   fds.append(fd)
   signal.pidfd_send_signal(fd,signal.SIGTERM)
  except ProcessLookupError: pass
 if fds: time.sleep(0.5)
 for fd in fds:
  try: signal.pidfd_send_signal(fd,signal.SIGKILL)
  except ProcessLookupError: pass
 print(json.dumps({'stopped':len(fds)}))
finally:
 for fd in fds: os.close(fd)
`;

// macOS has no /proc or pidfds. Require an exact cwd attribution and
// revalidate both the process birth stamp and cwd immediately before signalling.
async function stopDarwinProcesses(roots: string[]): Promise<number> {
  const snapshot = async () => {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,uid=,lstart=,command=']);
    return stdout.split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), uid: Number(match[3]), birth: match[4]!, command: match[5]! }] : [];
    });
  };
  const cwd = async (pid: number): Promise<string | undefined> => {
    try {
      const { stdout } = await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
      return stdout.split('\n').find(line => line.startsWith('n'))?.slice(1);
    } catch { return undefined; }
  };
  const inside = (path: string | undefined) => path !== undefined && roots.some(root => path === root || path.startsWith(`${root}/`));
  const rows = await snapshot();
  const protectedPids = new Set([process.pid]);
  let parent = rows.find(row => row.pid === process.pid)?.parent;
  while (parent && !protectedPids.has(parent)) {
    protectedPids.add(parent); parent = rows.find(row => row.pid === parent)?.parent;
  }
  const brokers = new Set(rows.filter(row => row.command.split(/\s+/).slice(0, 2).some(arg => arg.includes('trusty-squire'))).map(row => row.pid));
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (brokers.has(row.parent) && !brokers.has(row.pid)) { brokers.add(row.pid); changed = true; }
  }
  let stopped = 0;
  for (const row of rows) {
    if (protectedPids.has(row.pid) || brokers.has(row.pid) || row.uid !== process.getuid?.() || !inside(await cwd(row.pid))) continue;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const current = (await snapshot()).find(candidate => candidate.pid === row.pid);
      if (!current || current.birth !== row.birth || current.command !== row.command || !inside(await cwd(row.pid))) break;
      try { process.kill(row.pid, signal); if (signal === 'SIGTERM') stopped++; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      if (signal === 'SIGTERM') await new Promise(done => setTimeout(done, 500));
    }
  }
  return stopped;
}

export async function removeArchivedCornerData(supervisorRoot: string, cornerId: string, checkout: string, options: WholeStorageOptions = {}): Promise<StorageReclaimEntry[]> {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(cornerId)) throw new Error('invalid archived corner id');
  const base = resolve(supervisorRoot, 'beeline');
  if (!checkout.startsWith(`${base}/corners/`)) throw new Error('invalid archived checkout root');
  const roots = [checkout];
  for (const agent of await readdir(resolve(base, 'agents')).catch(() => [])) {
    if (/^[a-f0-9]{64}$/.test(agent)) roots.push(resolve(base, 'agents', agent, 'rooms', cornerId));
  }
  const existing: string[] = [];
  for (const path of roots) if (await ordinaryDirectory(path)) existing.push(path);
  if (!options.dryRun) {
    await stopKeptCornerEmulator(supervisorRoot, cornerId, 'corner archived');
    if (existing.length) {
      if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('unsupported archived process attribution platform');
      if (process.platform === 'darwin') {
        const stopped = await stopDarwinProcesses(existing);
        console.log(`[helper] archived corner ${cornerId} stopped ${stopped} attributed processes`);
      } else {
      const result = await exec('/usr/bin/python3', ['-c', STOP, JSON.stringify(existing), String(process.pid)], { timeout: 30_000, maxBuffer: 1024 });
      const { stopped } = JSON.parse(result.stdout) as { stopped: number };
      console.log(`[helper] archived corner ${cornerId} stopped ${stopped} attributed processes`);
      }
    }
  }
  const entries: StorageReclaimEntry[] = [];
  for (const path of existing) {
    // A remaining mount is an operational failure to retry, never permission
    // to walk into an unrelated mounted filesystem.
    if (await hasMount(path)) throw new Error(`archived corner mount still present: ${path}`);
    let allocatedBytes = 0, freedBytes = 0;
    const tree = await storageTree(path, options.progress).catch(() => undefined);
    const seen = new Map<string, { bytes: number; links: number; count: number; directory: boolean }>();
    for (const item of tree?.values() ?? []) {
      const key = `${item.dev}:${item.ino}`;
      const inode = seen.get(key) ?? { bytes: item.blocks, links: item.links, count: 0, directory: item.directory };
      inode.count++; seen.set(key, inode);
    }
    for (const item of seen.values()) { allocatedBytes += item.bytes; if (item.directory || item.count >= item.links) freedBytes += item.bytes; }
    if (!options.dryRun) await rm(path, { recursive: true, force: true, maxRetries: 3 });
    const entry: StorageReclaimEntry = { roomId: cornerId, path, kind: 'archived', allocatedBytes, freedBytes };
    entries.push(entry); options.log?.(entry);
  }
  // Missing roots are already clean, including after an interrupted prior pass.
  if (!options.dryRun && await lstat(checkout).catch(() => undefined)) throw new Error('archived checkout survived cleanup');
  return entries;
}
