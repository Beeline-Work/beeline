import { describe, expect, it } from 'vitest';
import { ancestors, defaultName, detectAgent, detectEnv, fromClientName, fromProcessName, joined, pickName, slug, statParent } from './agents.js';

describe('which app a session runs in', () => {
  it('reads each app’s own environment marker, and the override wins', () => {
    expect(detectEnv({ CLAUDECODE: '1' })).toBe('claude-code');
    expect(detectEnv({ CODEX_THREAD_ID: 't' })).toBe('codex');
    expect(detectEnv({ ANTIGRAVITY_SESSION_ID: 'a' })).toBe('antigravity');
    expect(detectEnv({ GEMINI_CLI: '1' })).toBe('gemini');
    expect(detectEnv({ OPENCODE: '1' })).toBe('opencode');
    expect(detectEnv({ PI_CODING_AGENT: '1' })).toBe('pi');
    expect(detectEnv({ HERMES_SESSION_ID: 'h' })).toBe('hermes');
    expect(detectEnv({ ZCODE: '1' })).toBe('zcode');
    expect(detectEnv({})).toBeUndefined();
    expect(detectEnv({ CLAUDECODE: '1', BEELINE_SESSION_AGENT: 'zcode' })).toBe('zcode');
  });

  it('maps MCP client names and process names to apps', () => {
    expect(fromClientName('claude-code')).toBe('claude-code');
    expect(fromClientName('codex-mcp-client')).toBe('codex');
    expect(fromClientName('gemini-cli-mcp-client')).toBe('gemini');
    expect(fromClientName('ZCode')).toBe('zcode');
    expect(fromClientName('not-zcode')).toBeUndefined();
    expect(fromClientName('pi')).toBe('pi');
    expect(fromClientName('pipeline')).toBeUndefined();
    expect(fromProcessName('/usr/local/bin/claude')).toBe('claude-code');
    expect(fromProcessName('/home/me/.npm/bin/codex.js')).toBe('codex');
    expect(fromProcessName('/usr/bin/opencode serve')).toBe('opencode');
    expect(fromProcessName('/opt/hermes/hermes')).toBe('hermes');
    expect(fromProcessName('/usr/bin/bash')).toBeUndefined();
  });

  it('prefers the nearest app ancestor over an inherited environment', () => {
    // 900 (us) ← 800 (a shell) ← 700 (Codex) ← 600 (Claude Code, whose variables Codex inherited) ← 1.
    const parent = (pid: number) => ({ 900: 800, 800: 700, 700: 600, 600: 1 } as Record<number, number>)[pid];
    const command = (pid: number) => ({ 800: '/bin/bash', 700: '/usr/bin/codex', 600: '/usr/bin/claude' } as Record<number, string>)[pid];
    expect(ancestors(900, parent)).toEqual([800, 700, 600]);
    expect(detectAgent({ CLAUDECODE: '1' }, 900, parent, command)).toEqual({ agent: 'codex', pid: 700 });
    expect(detectAgent({ BEELINE_SESSION_AGENT: 'claude-code' }, 900, parent, command)).toEqual({ agent: 'claude-code', pid: 600 });
    // A sandbox that hides ancestors falls back to the environment.
    expect(detectAgent({ CODEX_THREAD_ID: 't' }, 900, () => undefined, command)).toEqual({ agent: 'codex' });
    // Never past init nor round a loop.
    expect(ancestors(5, () => 5)).toEqual([5]);
  });

  it('reads the parent from a /proc stat line whose name holds spaces and parentheses', () => {
    expect(statParent('4242 (my (odd) app) S 77 4242 4242 0')).toBe(77);
    expect(statParent('garbage')).toBeUndefined();
  });
});

describe('a session’s name', () => {
  it('is the folder and the app, and the first free suffix', () => {
    expect(slug('  My Thing!! ')).toBe('my-thing');
    expect(slug('Café Ünïcode')).toBe('cafe-unicode');
    expect(joined('a'.repeat(50), '2')).toBe(`${'a'.repeat(38)}-2`);
    expect(defaultName('claude-code', '/tmp/My Thing')).toBe('my-thing-claude');
    expect(defaultName('codex', '/repo/sub/dir', '/repo')).toBe('repo-codex');
    expect(defaultName('pi', '/')).toBe('home-pi');
    const taken = new Set(['api-claude', 'api-claude-2']);
    expect(pickName(undefined, 'api-claude', n => taken.has(n))).toBe('api-claude-3');
    expect(pickName('Payments Bot', 'api-claude', n => taken.has(n))).toBe('payments-bot');
  });
});
