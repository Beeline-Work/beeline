// Detection, setup and wake paths for every app a session can join from. Claude Code and Codex are also proven
// live (SESSION-JOIN-1); the six others are covered here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentId } from './agents.js';
import { deliver } from './bridge.js';
import { formatFor, runHook, takesMail } from './hook.js';
import { antigravityOnce, answerMcp } from './pull-apps.js';
import { findSession, liveSessions } from './sessions.js';
import { mergeHookGroups, setupAgent } from './setup.js';
import { hookSessions, queueInbox, takeInbox, updateState, type JoinedSession } from './store.js';

const scratch = () => mkdtempSync(join(process.env.HOME ?? '/var/tmp', 'sj-'));
const context = (home: string, remove = false) => ({ env: { HOME: home, PATH: '' }, node: '/usr/bin/node', bundle: '/state/usebeeline.mjs', remove });

function joined(agent: AgentId, cwd: string, extra: Partial<JoinedSession> = {}): JoinedSession {
  return { key: `${agent}:${cwd}`, agent, cwd, name: `${agent}-member`, handle: `${agent.replace('-', '')}_member`, server: 'http://beeline.test', clientId: 'c',
    refreshToken: 'r', cursor: '0', deliveredWakes: [], joinedAt: '2026-10-30T00:00:00Z', ...extra };
}

async function join1(dir: string, member: JoinedSession) {
  await updateState(dir, state => { state.sessions.push(member); });
}

describe('each app’s hook output puts Beeline text in front of its model', () => {
  it('formats per app and event', () => {
    expect(formatFor('codex', 'stop', 'hi')).toBe('{"decision":"block","reason":"hi"}');
    expect(formatFor('codex', 'post-tool-use', 'hi')).toContain('"PostToolUse"');
    expect(formatFor('claude-code', 'session-start', 'hi')).toContain('"SessionStart"');
    expect(formatFor('gemini', 'user-prompt-submit', 'hi')).toContain('BeforeAgent');
    expect(formatFor('gemini', 'post-tool-use', 'hi')).toContain('AfterTool');
    expect(formatFor('gemini', 'stop', 'hi')).toBe('{"decision":"deny","reason":"hi"}');
    expect(formatFor('antigravity', 'session-start', 'hi')).toBe('{"injectSteps":[{"userMessage":"hi"}]}');
    expect(formatFor('antigravity', 'stop', 'hi')).toBe('{"decision":"continue","reason":"hi"}');
    for (const agent of ['opencode', 'pi', 'hermes', 'zcode'] as const) expect(formatFor(agent, 'poll', 'hi')).toBe('hi');
  });

  it('takes messages only where the app shows them', () => {
    expect(takesMail('opencode', 'status')).toBe(false);
    expect(takesMail('opencode', 'poll')).toBe(true);
    expect(takesMail('hermes', 'stop')).toBe(false);
    expect(takesMail('pi', 'post-tool-use')).toBe(true);
    expect(takesMail('antigravity', 'post-tool-use')).toBe(false);
    expect(takesMail('antigravity', 'user-prompt-submit')).toBe(true);
    expect(takesMail('gemini', 'stop')).toBe(true);
  });
});

describe.each([
  ['opencode', 'poll', { session: 'ses_1' }, (out: string) => expect(out).toContain('tagged you')],
  ['pi', 'poll', { session: 'pi-1' }, (out: string) => expect(out).toContain('tagged you')],
  ['hermes', 'poll', { session: 'h-1' }, (out: string) => expect(out).toContain('tagged you')],
  ['zcode', 'poll', { session: 'z-1' }, (out: string) => expect(out).toContain('tagged you')],
  ['gemini', 'stop', { payload: { session_id: 'g-1' } }, (out: string) => expect(JSON.parse(out)).toMatchObject({ decision: 'deny' })],
  ['antigravity', 'user-prompt-submit', { payload: { conversationId: 'ag-1' } }, (out: string) => expect(JSON.parse(out).injectSteps[0].userMessage).toContain('tagged you')],
] as const)('%s wake path', (agent, event, input, check) => {
  it('records the session from its hook, and hands over a waiting tag once, in the app’s own format', async () => {
    const dir = scratch(), cwd = scratch();
    const member = joined(agent, cwd);
    await join1(dir, member);
    const payload = { cwd, ...('payload' in input ? input.payload : {}) };
    const session = 'session' in input ? input.session : undefined;
    // Nothing waits: the hook only records the session.
    expect(runHook(dir, { agent, event, payload, session, pid: process.pid }, Date.now())).toBe('');
    const live = liveSessions({ claude: () => [], codex: () => [], hooks: () => hookSessions(dir) });
    expect(findSession(member, live)?.agent).toBe(agent);
    // The bridge leaves text for apps it cannot push to; the app collects it at its next hook or poll.
    queueInbox(dir, member.key, 'Beeline: @ana tagged you');
    expect(await deliver(dir, member, findSession(member, live))).toBe('waiting for the app to collect it');
    const out = runHook(dir, { agent, event, payload, session, pid: process.pid });
    check(out);
    expect(runHook(dir, { agent, event, payload, session, pid: process.pid })).toBe('');
    // A session that ended is gone from the finder.
    runHook(dir, { agent, event: 'session-end', payload, session });
    expect(hookSessions(dir).filter(h => h.agent === agent)).toEqual([]);
  });
});

describe('the session finder', () => {
  it('keeps a member in its own conversation, else takes the newest of its app in its folder, never another member’s', () => {
    const live = liveSessions({
      claude: () => [{ pid: 10, sessionId: 'old', cwd: '/a' }, { pid: 30, sessionId: 'new', cwd: '/a', messagingSocketPath: '/s' }],
      codex: () => [{ pid: 40, threadId: 't1', cwd: '/a', rollout: '/r' }],
      hooks: () => [{ agent: 'codex', sessionId: 't1', cwd: '/a', seenAt: 1 }, { agent: 'pi', sessionId: 'p', cwd: '/a', seenAt: 1 }],
    });
    expect(live.map(s => `${s.agent}:${s.sessionId}`)).toEqual(['claude-code:old', 'claude-code:new', 'codex:t1', 'pi:p']);
    const member = joined('claude-code', '/a', { sessionId: 'old' });
    expect(findSession(member, live)?.sessionId).toBe('old');
    expect(findSession({ ...member, sessionId: 'closed' }, live)?.sessionId).toBe('new');
    const other = joined('claude-code', '/b', { key: 'other', sessionId: 'new' });
    expect(findSession({ ...member, sessionId: 'closed' }, live, [other])?.sessionId).toBe('old');
    expect(findSession(joined('claude-code', '/elsewhere'), live)).toBeUndefined();
  });
});

describe('setup is additive and reversible', () => {
  it('adds one hook group beside the person’s own, and takes only ours out again', () => {
    const hooks: Record<string, unknown> = { SessionStart: [{ hooks: [{ type: 'command', command: 'mine' }, { type: 'command', command: '"/n" /b session hook codex session-start' }] }] };
    mergeHookGroups(hooks, 'codex', [['SessionStart', { hooks: [{ type: 'command', command: '/n /b session hook codex session-start' }] }]], false);
    expect(JSON.stringify(hooks).match(/session hook codex/g)).toHaveLength(1);
    mergeHookGroups(hooks, 'codex', [], true);
    expect(hooks).toEqual({ SessionStart: [{ hooks: [{ type: 'command', command: 'mine' }] }] });
  });

  it.each([
    ['claude-code', (home: string) => join(home, '.claude/settings.json'), (v: any) => v.hooks.SessionStart[0].hooks[0].command],
    ['codex', (home: string) => join(home, '.codex/hooks.json'), (v: any) => v.hooks.SessionStart[0].hooks[0].command],
    ['gemini', (home: string) => join(home, '.gemini/settings.json'), (v: any) => v.hooks.AfterAgent[0].hooks[0].command],
    ['antigravity', (home: string) => join(home, '.gemini/config/hooks.json'), (v: any) => v.beeline.Stop[0].command],
  ] as const)('%s hooks keep the person’s settings', (agent, file, command) => {
    const home = scratch();
    mkdirSync(join(file(home), '..'), { recursive: true });
    writeFileSync(file(home), JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own' }] }] } }));
    const before = readFileSync(file(home), 'utf8');
    expect(setupAgent(agent, context(home)).length).toBeGreaterThan(0);
    const value = JSON.parse(readFileSync(file(home), 'utf8'));
    expect(value.theme).toBe('dark');
    expect(command(value)).toBe(`/usr/bin/node /state/usebeeline.mjs session hook ${agent} ${agent === 'gemini' || agent === 'antigravity' ? 'stop' : 'session-start'}`);
    expect(readFileSync(`${file(home)}.bak-beeline`, 'utf8')).toBe(before);
    // Running it again changes nothing.
    expect(setupAgent(agent, context(home))).toEqual([]);
    setupAgent(agent, context(home, true));
    expect(JSON.parse(readFileSync(file(home), 'utf8'))).toEqual(JSON.parse(before));
  });

  it('antigravity registers its sidecar, which hands waiting text to the App and keeps a failed handoff', async () => {
    const home = scratch();
    setupAgent('antigravity', context(home));
    const sidecar = JSON.parse(readFileSync(join(home, '.gemini/config/sidecars/beeline/sidecar.json'), 'utf8'));
    expect(sidecar.args).toEqual(['/state/usebeeline.mjs', 'session', 'antigravity-sidecar']);
    expect(JSON.parse(readFileSync(join(home, '.gemini/config/config.json'), 'utf8')).sidecars.beeline).toEqual({ enabled: true });
    const dir = scratch(), cwd = '/proj';
    const member = joined('antigravity', cwd, { sessionId: 'ag-1' });
    await join1(dir, member);
    const live = [{ agent: 'antigravity' as const, sessionId: 'ag-1', cwd, seenAt: Date.now() }];
    queueInbox(dir, member.key, 'Beeline: tag one');
    const sent: [string, string][] = [];
    expect(await antigravityOnce(dir, live, async (id, text) => { sent.push([id, text]); })).toBe(1);
    expect(sent).toEqual([['ag-1', 'Beeline: tag one']]);
    queueInbox(dir, member.key, 'Beeline: tag two');
    expect(await antigravityOnce(dir, live, async () => { throw new Error('agentapi missing'); })).toBe(0);
    expect(takeInbox(dir, member.key)).toBe('Beeline: tag two');
    setupAgent('antigravity', context(home, true));
    expect(existsSync(join(home, '.gemini/config/sidecars/beeline'))).toBe(false);
  });

  it.each([
    ['opencode', (home: string) => join(home, '.config/opencode/plugins/beeline.ts'), 'session", "hook", "opencode"'],
    ['pi', (home: string) => join(home, '.pi/agent/extensions/beeline.ts'), '"session", "hook", "pi"'],
    ['hermes', (home: string) => join(home, '.hermes/plugins/beeline/__init__.py'), '"session", "hook", "hermes"'],
  ] as const)('%s gets a plugin that runs the stable bundle, removed on leave', (agent, file, call) => {
    const home = scratch();
    setupAgent(agent, context(home));
    const code = readFileSync(file(home), 'utf8');
    expect(code).toContain('/state/usebeeline.mjs');
    expect(code).toContain(call);
    expect(code).not.toContain('__BUNDLE__');
    setupAgent(agent, context(home, true));
    expect(existsSync(file(home))).toBe(false);
  });

  it('zcode gets our MCP server where ZCode reads servers, and its inbox tool hands over waiting text', async () => {
    const home = scratch();
    mkdirSync(join(home, '.agents'), { recursive: true });
    writeFileSync(join(home, '.agents/mcp.json'), JSON.stringify({ mcpServers: { memory: { command: 'npx' } } }));
    setupAgent('zcode', context(home));
    // ZCode's own file has no server, so it reads `.agents`: ours goes there.
    expect(JSON.parse(readFileSync(join(home, '.agents/mcp.json'), 'utf8')).mcpServers.beeline.args).toEqual(['/state/usebeeline.mjs', 'session', 'mcp']);
    expect(existsSync(join(home, '.zcode/cli/config.json'))).toBe(false);
    const dir = scratch(), cwd = '/zproj';
    const member = joined('zcode', cwd);
    await join1(dir, member);
    expect(answerMcp(dir, cwd, { id: 1, method: 'tools/list' })).toMatchObject({ result: { tools: [{ name: 'beeline_inbox' }] } });
    queueInbox(dir, member.key, 'Beeline: @ana tagged you');
    expect(answerMcp(dir, cwd, { id: 2, method: 'tools/call', params: { name: 'beeline_inbox' } })).toMatchObject({ result: { content: [{ text: 'Beeline: @ana tagged you' }] } });
    expect(answerMcp(dir, cwd, { id: 3, method: 'tools/call', params: { name: 'beeline_inbox' } })).toMatchObject({ result: { content: [{ text: 'No Beeline messages are waiting.' }] } });
    expect(answerMcp(dir, '/other', { id: 4, method: 'tools/call', params: { name: 'beeline_inbox' } })).toMatchObject({ result: { content: [{ text: expect.stringContaining('has not joined') }] } });
    expect(answerMcp(dir, cwd, { method: 'notifications/initialized' })).toBeUndefined();
    setupAgent('zcode', context(home, true));
    expect(JSON.parse(readFileSync(join(home, '.agents/mcp.json'), 'utf8'))).toEqual({ mcpServers: { memory: { command: 'npx' } } });
  });

  it('refuses a config it cannot read instead of rewriting it', () => {
    const home = scratch();
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini/settings.json'), '[]');
    expect(() => setupAgent('gemini', context(home))).toThrow(/not a JSON object/);
    expect(readFileSync(join(home, '.gemini/settings.json'), 'utf8')).toBe('[]');
  });
});
