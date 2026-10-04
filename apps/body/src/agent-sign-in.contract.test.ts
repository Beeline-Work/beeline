/**
 * Contract for the harness logins `@agent login` drives. Their headless
 * output is not a public API: these tests pin the exact text each CLI printed
 * (fixtures) and, where a CLI is installed on this machine, re-read its help
 * so a renamed flag fails here before it reaches an owner.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CLI_SIGN_INS,
  parseCodexDeviceLogin,
  parseCursorLogin,
  parseGrokDeviceLogin,
} from './agent-sign-in.js';
import { CODEX_DEVICE_OUTPUT, CURSOR_LOGIN_OUTPUT, GROK_DEVICE_OUTPUT } from './agent-sign-in.fixtures.js';

const NOW = 1_800_000_000_000;

function installed(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function help(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('harness login contract', () => {
  it('reads the link, code and expiry Codex prints', () => {
    expect(parseCodexDeviceLogin(CODEX_DEVICE_OUTPUT, NOW)).toEqual({
      kind: 'device-code',
      authorizeUrl: 'https://auth.openai.com/codex/device',
      userCode: 'EBQ9-VJCLN',
      expiresAt: NOW + 15 * 60_000,
    });
  });

  it('reads the link and code Grok prints', () => {
    expect(parseGrokDeviceLogin(GROK_DEVICE_OUTPUT, NOW)).toMatchObject({
      kind: 'device-code',
      authorizeUrl: 'https://accounts.x.ai/oauth2/device?user_code=2RDF-2C74',
      userCode: '2RDF-2C74',
    });
  });

  it('reads the link Cursor prints', () => {
    expect(parseCursorLogin(CURSOR_LOGIN_OUTPUT)).toEqual({
      kind: 'approve-wait',
      authorizeUrl: expect.stringMatching(/^https:\/\/cursor\.com\/loginDeepControl\?challenge=[\w-]+&uuid=/),
    });
  });

  it('waits rather than guessing while the output is incomplete', () => {
    expect(parseCodexDeviceLogin(CODEX_DEVICE_OUTPUT.split('2.')[0]!, NOW)).toBeUndefined();
    expect(parseGrokDeviceLogin(GROK_DEVICE_OUTPUT.split('Confirm')[0]!, NOW)).toBeUndefined();
    expect(parseCursorLogin('Starting login process...\n')).toBeUndefined();
  });

  it('runs each harness its own headless login', () => {
    expect(CLI_SIGN_INS.codex).toMatchObject({ command: 'codex', args: ['login', '--device-auth'] });
    expect(CLI_SIGN_INS.grok).toMatchObject({ command: 'grok', args: ['login', '--device-auth'] });
    expect(CLI_SIGN_INS.cursor).toMatchObject({
      command: 'cursor-agent',
      args: ['login'],
      env: { NO_OPEN_BROWSER: '1' },
    });
  });

  it.skipIf(!installed('codex'))('matches the installed Codex login flags', () => {
    expect(help('codex', ['login', '--help'])).toContain('--device-auth');
  });

  it.skipIf(!installed('grok'))('matches the installed Grok login flags', () => {
    expect(help('grok', ['login', '--help'])).toContain('--device-auth');
  });

  it.skipIf(!installed('cursor-agent'))('matches the installed Cursor login command', () => {
    expect(help('cursor-agent', ['--help'])).toContain('login');
  });
});
