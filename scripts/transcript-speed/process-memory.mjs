import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
/** Sum proportional resident memory for the packaged process and descendants. */
export function desktopMemory() {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n')
    .flatMap(line => { const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/); return m ? [{ pid: +m[1], parent: +m[2], args: m[3] }] : []; });
  const root = rows.find(row => row.args === '/tmp/transcript-desktop-package/usr/bin/beeline-desktop');
  if (!root) throw new Error('Expected packaged fixture process is not running');
  const pids = new Set([root.pid]);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (pids.has(row.parent) && !pids.has(row.pid)) { pids.add(row.pid); changed = true; } }
  const processes = [...pids].map(pid => {
    const text = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const match = text.match(/^Pss:\s+(\d+) kB$/m);
    if (!match) throw new Error(`Missing PSS for fixture process ${pid}`);
    return { pid, pssKiB: +match[1] };
  });
  return { processes, totalPssKiB: processes.reduce((sum, process) => sum + process.pssKiB, 0) };
}
