// Reproduction (SESSION-JOIN-RULES-1): a joined session never received Beeline's working rules. Join and the bridge
// only call tools/call, so the connector's MCP instructions never reach the model; Claude Code's in-session server
// answered initialize with no instructions; and the SessionStart hook printed only waiting mail.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderRules } from './bridge.js';
import { runHook } from './hook.js';
import { queueInbox, stateDir, updateState, type JoinedSession } from './store.js';

const runner = { node: '/node', bundle: '/b/usebeeline.mjs' };
const codex: JoinedSession = { key: 'codex:/w', agent: 'codex', cwd: '/w', name: 'Codex', handle: 'codex_w', server: 'http://proof',
  clientId: 'c', refreshToken: 'r', cursor: '0', deliveredWakes: [], joinedAt: '', sessionId: 's1' };

describe('SESSION-JOIN-RULES-1: a joined session receives the Beeline rules', () => {
  it('renders the rules with the session\'s own commands and identity', () => {
    const text = renderRules(codex, runner);
    expect(text.startsWith('Beeline: you are @codex_w')).toBe(true);
    expect(text).toContain("/node /b/usebeeline.mjs session tool <name> '<json arguments>' --as codex:/w");
    for (const rule of ['not a plain reply', 'done:, blocked:, failed:, needs-decision:', 'one step up', 'Code work belongs in a corner',
      'approve_merge on the exact head SHA', 'post short progress there']) expect(text).toContain(rule);
  });

  it('puts the rules in front of the model at session start, ahead of waiting mail, and only then', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sj-rules-'));
    const dir = stateDir({ HOME: home, XDG_STATE_HOME: home });
    await updateState(dir, state => { state.sessions = [codex]; });
    queueInbox(dir, codex.key, 'Beeline: order for you');
    const rules = (joined: JoinedSession) => renderRules(joined, runner);
    const start = JSON.parse(runHook(dir, { agent: 'codex', event: 'session-start', payload: { session_id: 's1', cwd: '/w' }, rules }));
    const context = start.hookSpecificOutput.additionalContext as string;
    expect(context.indexOf('Beeline: you are @codex_w')).toBe(0);
    expect(context).toContain('Beeline: order for you');
    expect(runHook(dir, { agent: 'codex', event: 'user-prompt-submit', payload: { session_id: 's1', cwd: '/w' }, rules })).toBe('');
  });

  it('serves the rules as Claude Code in-session MCP server instructions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sj-claude-'));
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') };
    // This test process stands in for the Claude Code session that starts the server.
    mkdirSync(join(env.CLAUDE_CONFIG_DIR, 'sessions'), { recursive: true });
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'claude-s', cwd: '/repo' }));
    const claude: JoinedSession = { ...codex, key: 'claude-code:/repo', agent: 'claude-code', cwd: '/repo', handle: 'claude_r', sessionId: 'claude-s', pid: process.pid };
    await updateState(stateDir(env), state => { state.sessions = [claude]; });
    const script = `import { runClaudeMcp } from ${JSON.stringify(resolve('src/session-join/claude-mcp.ts'))};
      import { renderRules } from ${JSON.stringify(resolve('src/session-join/bridge.ts'))};
      import { stateDir } from ${JSON.stringify(resolve('src/session-join/store.ts'))};
      await runClaudeMcp(stateDir(process.env), process.env, joined => renderRules(joined, { node: 'node', bundle: '/b' }));`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no initialize answer: ${out}`)), 20_000);
      child.stdout.on('data', () => { if (out.includes('\n')) { clearTimeout(timer); done(); } });
    });
    child.stdin.end();
    const answer = JSON.parse(out.split('\n')[0]!) as { result: { instructions?: string } };
    expect(answer.result.instructions).toContain('Beeline: you are @claude_r');
    expect(answer.result.instructions).toContain('--as claude-code:/repo');
  }, 30_000);
});
