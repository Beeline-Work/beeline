import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSignIn,
  agentSignInFrame,
  answerAgentSignInFrame,
  reportAgentSignInResult,
  type AgentSignInOptions,
} from './agent-sign-in.js';
import { CODEX_DEVICE_OUTPUT, CURSOR_LOGIN_OUTPUT } from './agent-sign-in.fixtures.js';

const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const CARD = 'c'.repeat(64);

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: string | undefined;
  kill(signal: string) {
    this.killed = signal;
    this.emit('exit', null, signal);
    return true;
  }
  print(text: string) {
    this.stdout.write(text);
  }
  finish(code: number) {
    this.emit('exit', code, null);
  }
}

describe('@agent login on the agent machine', () => {
  let home: string;
  let children: FakeChild[];
  let spawnCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
  let results: Array<{ attemptId: string; result: unknown }>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-sign-in-'));
    children = [];
    spawnCalls = [];
    results = [];
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function signIn(overrides: Partial<AgentSignInOptions>) {
    return new AgentSignIn({
      harness: 'codex',
      operatorHome: home,
      agentEnv: { PATH: '/agent/bin' },
      onResult: (attemptId, result) => results.push({ attemptId, result }),
      spawn: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        spawnCalls.push({ command, args, env: options.env });
        const child = new FakeChild();
        children.push(child);
        return child;
      }) as never,
      now: () => 1_800_000_000_000,
      ...overrides,
    });
  }

  it('runs Codex device-code login in the operator home and reports when it finishes', async () => {
    const signedIn = vi.fn();
    const codex = signIn({ harness: 'codex', onSignedIn: signedIn });
    const started = codex.start(ATTEMPT);
    children[0]!.print(CODEX_DEVICE_OUTPUT);
    await expect(started).resolves.toEqual({
      kind: 'device-code',
      authorizeUrl: 'https://auth.openai.com/codex/device',
      userCode: 'EBQ9-VJCLN',
      expiresAt: 1_800_000_000_000 + 15 * 60_000,
    });
    expect(spawnCalls[0]).toMatchObject({ command: 'codex', args: ['login', '--device-auth'] });
    expect(spawnCalls[0]!.env.HOME).toBe(home);
    expect(spawnCalls[0]!.env.PATH).toBe('/agent/bin');
    expect(spawnCalls[0]!.env).not.toHaveProperty('CODEX_HOME');
    children[0]!.finish(0);
    expect(results).toEqual([{ attemptId: ATTEMPT, result: { ok: true } }]);
    expect(signedIn).toHaveBeenCalledTimes(1);
  });

  it('reports a device-code login the CLI refused with its own last line', async () => {
    const grok = signIn({ harness: 'grok' });
    const started = grok.start(ATTEMPT);
    children[0]!.print(
      '\nTo sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=2RDF-2C74\n\nConfirm this code in your browser:\n\n  2RDF-2C74\n\nWaiting for authorization...\n',
    );
    await expect(started).resolves.toMatchObject({ kind: 'device-code', userCode: '2RDF-2C74' });
    children[0]!.print('Error: authorization denied\n');
    children[0]!.finish(1);
    expect(results).toEqual([
      {
        attemptId: ATTEMPT,
        result: { ok: false, error: '`grok login` stopped: Error: authorization denied' },
      },
    ]);
  });

  it('runs Cursor approve-and-wait login headless', async () => {
    const cursor = signIn({ harness: 'cursor' });
    const started = cursor.start(ATTEMPT);
    children[0]!.print(CURSOR_LOGIN_OUTPUT);
    await expect(started).resolves.toEqual({
      kind: 'approve-wait',
      authorizeUrl: expect.stringMatching(/^https:\/\/cursor\.com\/loginDeepControl\?challenge=/),
    });
    expect(spawnCalls[0]).toMatchObject({ command: 'cursor-agent', args: ['login'] });
    expect(spawnCalls[0]!.env.NO_OPEN_BROWSER).toBe('1');
  });

  it('says the CLI is missing instead of hanging', async () => {
    const codex = signIn({ harness: 'codex' });
    const started = codex.start(ATTEMPT);
    children[0]!.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
    await expect(started).rejects.toThrow("`codex` is not installed on the agent's machine.");
  });

  it('fails a login that exits before printing its link', async () => {
    const codex = signIn({ harness: 'codex' });
    const started = codex.start(ATTEMPT);
    children[0]!.print('device code login is not enabled for this Codex server.\n');
    children[0]!.finish(1);
    await expect(started).rejects.toThrow(
      '`codex login` stopped: device code login is not enabled for this Codex server.',
    );
    expect(results).toEqual([]);
  });

  it('replaces an unfinished login with a new one', async () => {
    const codex = signIn({ harness: 'codex' });
    const first = codex.start(ATTEMPT);
    children[0]!.print(CODEX_DEVICE_OUTPUT);
    await first;
    const second = codex.start('00000000-0000-4000-8000-000000000002');
    expect(children[0]!.killed).toBe('SIGTERM');
    children[1]!.print(CODEX_DEVICE_OUTPUT);
    await second;
    expect(results).toEqual([]);
  });

  it('verifies and saves a Pi provider key into its env file, live env and sessions', async () => {
    const envFile = join(home, 'connect', 'agent.env');
    await mkdir(join(home, 'connect'), { recursive: true });
    await writeFile(envFile, 'OPENROUTER_API_KEY="sk-or-old"\nOTHER="kept"\n', { mode: 0o600 });
    const agentEnv: Record<string, string> = { PATH: '/agent/bin', OPENROUTER_API_KEY: 'sk-or-old' };
    const saved = vi.fn();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const pi = signIn({
      harness: 'pi',
      agentEnv,
      llmEnvFile: envFile,
      onSignedIn: saved,
      fetch: fetchMock as never,
    });
    await expect(pi.start(ATTEMPT)).resolves.toEqual({ kind: 'api-key', provider: 'openrouter' });
    await pi.submit(ATTEMPT, '  sk-or-new  ');
    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/key', expect.anything());
    expect(await readFile(envFile, 'utf8')).toBe('OPENROUTER_API_KEY="sk-or-new"\nOTHER="kept"\n');
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    expect(agentEnv.OPENROUTER_API_KEY).toBe('sk-or-new');
    expect(saved).toHaveBeenCalledTimes(1);
    await expect(pi.submit(ATTEMPT, 'again')).rejects.toThrow('expired or was already used');
  });

  it('refuses a key the provider rejects and keeps the old one', async () => {
    const envFile = join(home, 'agent.env');
    await writeFile(envFile, 'GOOSE_PROVIDER="anthropic"\nANTHROPIC_API_KEY="sk-ant-old"\n');
    const goose = signIn({
      harness: 'goose',
      llmEnvFile: envFile,
      fetch: vi.fn(async () => new Response('{}', { status: 401 })) as never,
    });
    await expect(goose.start(ATTEMPT)).resolves.toEqual({ kind: 'api-key', provider: 'anthropic' });
    await expect(goose.submit(ATTEMPT, 'sk-ant-bad')).rejects.toThrow('Anthropic rejected the key (401).');
    expect(await readFile(envFile, 'utf8')).toContain('sk-ant-old');
    // A rejected key keeps the card open for another paste.
    await expect(goose.start(ATTEMPT)).resolves.toMatchObject({ kind: 'api-key' });
  });

  it("writes an OpenCode key into OpenCode's own store, keeping other providers", async () => {
    const store = join(home, '.local', 'share', 'opencode', 'auth.json');
    await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true });
    await writeFile(store, JSON.stringify({ anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } }));
    const opencode = signIn({
      harness: 'opencode',
      model: () => 'openrouter/z-ai/glm-5.3-flash',
      fetch: vi.fn(async () => new Response('{}', { status: 200 })) as never,
    });
    await expect(opencode.start(ATTEMPT)).resolves.toEqual({ kind: 'api-key', provider: 'openrouter' });
    await opencode.submit(ATTEMPT, 'sk-or-new');
    expect(JSON.parse(await readFile(store, 'utf8'))).toEqual({
      anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 },
      openrouter: { type: 'api', key: 'sk-or-new' },
    });
    expect((await stat(store)).mode & 0o777).toBe(0o600);
  });

  it("sends an OpenCode agent on OpenCode's own models back to its machine", async () => {
    const opencode = signIn({ harness: 'opencode', model: () => 'opencode/big-pickle' });
    await expect(opencode.start(ATTEMPT)).rejects.toThrow('Run `opencode auth login` on its machine.');
  });

  it('says a Pi agent with no provider key needs beeline connect', async () => {
    await expect(signIn({ harness: 'pi' }).start(ATTEMPT)).rejects.toThrow(
      'This agent has no provider key to replace. Run `beeline connect` on its machine.',
    );
  });

  it('reports each step with its card and never logs or reports a key', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const logs: string[] = [];
    const cards = new Map<string, string>();
    const envFile = join(home, 'agent.env');
    await writeFile(envFile, 'XAI_API_KEY="xai-old"\n');
    const pi = signIn({
      harness: 'pi',
      llmEnvFile: envFile,
      fetch: vi.fn(async () => new Response('{}', { status: 403 })) as never,
    });
    const log = (line: string) => logs.push(line);
    await answerAgentSignInFrame({ execute }, 'agent', pi, agentSignInFrame({
      type: 'agent-sign-in', step: 'start', attemptId: ATTEMPT, cardId: CARD,
    })!, cards, log);
    expect(execute).toHaveBeenLastCalledWith('reportAgentSignIn', {
      agentId: 'agent', attemptId: ATTEMPT, kind: 'api-key', provider: 'xai',
    });
    await answerAgentSignInFrame({ execute }, 'agent', pi, {
      type: 'agent-sign-in', step: 'code', attemptId: ATTEMPT, code: 'xai-secret-pasted-key',
    }, cards, log);
    expect(execute).toHaveBeenLastCalledWith('reportAgentSignIn', {
      agentId: 'agent', attemptId: ATTEMPT, cardId: CARD, outcome: 'failed',
      error: 'xAI rejected the key (403).',
    });
    await reportAgentSignInResult({ execute }, 'agent', ATTEMPT, cards, { ok: true }, log);
    expect(execute).toHaveBeenLastCalledWith('reportAgentSignIn', {
      agentId: 'agent', attemptId: ATTEMPT, cardId: CARD, outcome: 'signed-in',
    });
    expect(JSON.stringify([execute.mock.calls, logs])).not.toContain('xai-secret-pasted-key');
  });

  it('drops malformed frames', () => {
    expect(agentSignInFrame({ type: 'agent-sign-in', step: 'start', attemptId: ATTEMPT })).toBeUndefined();
    expect(agentSignInFrame({ type: 'agent-sign-in', step: 'code', attemptId: ATTEMPT })).toBeUndefined();
    expect(agentSignInFrame({ type: 'other', step: 'start', attemptId: ATTEMPT, cardId: CARD }))
      .toBeUndefined();
  });
});
