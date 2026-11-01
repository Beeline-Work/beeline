import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { codexHome } from './codex.js';
import { hookCommand, type SetupContext } from './setup.js';

interface Hook {
  key: string; sourcePath: string; source: string; eventName: string; handlerType: string;
  command?: string; matcher?: string; timeoutSec?: number; currentHash: string; isManaged: boolean; pluginId: string | null;
}
interface Edit { keyPath: string; value: string; mergeStrategy: 'replace' }

/** Codex owns the hash format and normalization. Trust only the exact Beeline declaration we just installed. */
export function beelineTrustEdits(hooks: Hook[], context: SetupContext): Edit[] {
  const path = join(codexHome(context.env), 'hooks.json');
  const expected = hookCommand(context, 'codex', 'session-start');
  const own = hooks.filter(h => h.sourcePath === path && h.source === 'user' && !h.isManaged && h.pluginId === null
    && h.eventName === 'sessionStart' && h.handlerType === 'command' && h.command === expected && h.matcher === '*'
    && h.timeoutSec === 10 && h.key.startsWith(path) && /^:session_start:\d+:\d+$/.test(h.key.slice(path.length))
    && /^sha256:[0-9a-f]{64}$/.test(h.currentHash));
  if (own.length !== 1) return [];
  const hook = own[0]!;
  return [{ keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'replace' }];
}

/** Verified against Codex 0.165.0. Unknown APIs/formats retain Codex's own review prompt. */
export async function trustCodexHook(context: SetupContext, bin: string, cwd: string): Promise<boolean> {
  // A transient stdio config client creates no thread and performs no daemon lifecycle operation.
  const child = spawn(bin, ['app-server', '--stdio'], { env: context.env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  let id = 0, buffer = '';
  const pending = new Map<number, { resolve: (value: any) => void; reject: () => void }>();
  const fail = () => { for (const p of pending.values()) p.reject(); pending.clear(); };
  child.once('error', fail);
  child.once('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.on('data', chunk => {
    buffer += String(chunk);
    if (buffer.length > 2 << 20) { fail(); child.kill(); return; }
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const answer = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        const p = answer.id === undefined ? undefined : pending.get(answer.id);
        if (p) { pending.delete(answer.id!); if (answer.error) p.reject(); else p.resolve(answer.result); }
      } catch { /* An unknown response cannot grant trust. */ }
    }
  });
  const request = (method: string, params: object): Promise<any> => new Promise((resolve, reject) => {
    const key = ++id;
    pending.set(key, { resolve, reject: () => reject(new Error('Codex hook trust unavailable')) });
    child.stdin.write(JSON.stringify({ id: key, method, params }) + '\n');
  });
  const timer = setTimeout(() => { fail(); child.kill(); }, 15_000);
  try {
    await request('initialize', { clientInfo: { name: 'beeline-session-join', version: '1' }, capabilities: { experimentalApi: true } });
    const list = await request('hooks/list', { cwds: [cwd] }) as { data?: { hooks?: Hook[] }[] };
    if (!Array.isArray(list.data)) return false;
    const edits = beelineTrustEdits(list.data.flatMap(entry => entry.hooks ?? []), context);
    if (edits.length !== 1) return false;
    const result = await request('config/batchWrite', { edits, reloadUserConfig: true }) as { status?: string };
    return result.status === 'ok';
  } catch { return false; }
  finally { clearTimeout(timer); child.kill(); }
}
