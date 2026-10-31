import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runSessionCommand } from './command.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});

afterEach(() => { vi.mocked(mkdirSync).mockReset(); vi.unstubAllGlobals(); });

it.each(['state write', 'network'] as const)('SESSION-JOIN-CODEX-CLEAN-1: names the native permission step after a blocked %s', async blocked => {
  const home = mkdtempSync(join(tmpdir(), 'beeline-codex-permissions-'));
  const env = { HOME: home, CODEX_HOME: join(home, 'codex'), XDG_STATE_HOME: join(home, 'state'),
    BEELINE_SESSION_AGENT: 'codex', BEELINE_SESSION_BUNDLE: join(home, 'unused.mjs'), PATH: '' };
  const denied = Object.assign(new Error('sandbox denied access'), blocked === 'state write'
    ? { code: 'ENOENT', syscall: 'mkdir' } : { code: 'EPERM', syscall: 'connect' });
  if (blocked === 'state write') {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ client_id: 'proof' }), { status: 201 })));
    vi.mocked(mkdirSync).mockImplementationOnce(() => { throw denied; });
  } else {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: denied })));
  }
  try {
    await expect(runSessionCommand(['join', '--server', 'http://127.0.0.1:1'], env)).rejects.toThrow(
      'Run /permissions, pick "Ask for approval", then run Join again.',
    );
    expect(existsSync(env.CODEX_HOME)).toBe(false);
    expect(existsSync(env.XDG_STATE_HOME)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('preserves an unrelated Codex connection error instead of calling it a permission denial', async () => {
  const error = new TypeError('fetch failed', { cause: Object.assign(new Error('server offline'), { code: 'ECONNREFUSED' }) });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
  await expect(runSessionCommand(['join'], { BEELINE_SESSION_AGENT: 'codex', BEELINE_SESSION_BUNDLE: '/unused.mjs',
    HOME: '/unused-beeline-test-home', XDG_STATE_HOME: '/unused-beeline-test-state', PATH: '' })).rejects.toBe(error);
});
