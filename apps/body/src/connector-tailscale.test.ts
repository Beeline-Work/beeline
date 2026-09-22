import { describe, expect, it } from 'vitest';
import {
  installTailscale,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
} from './connector-tailscale.js';

function runner(results: readonly TailscaleCommandResult[]) {
  const calls: { command: string; args: readonly string[] }[] = [];
  let index = 0;
  const run: TailscaleCommandRunner = async (command, args) => {
    calls.push({ command, args });
    return results[index++] ?? { code: 1, stdout: '', stderr: 'unexpected command' };
  };
  return { calls, run };
}

describe('installTailscale', () => {
  it('accepts an already connected helper and reports its account', async () => {
    const command = runner([
      { code: 0, stdout: '1.90.6', stderr: '' },
      {
        code: 0,
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { UserID: 42 },
          User: { '42': { LoginName: 'sol@example.test' } },
        }),
        stderr: '',
      },
    ]);

    const result = await installTailscale({ run: command.run });

    expect(result.status).toBe('connected');
    expect(result.status === 'connected' && result.signedInAs).toBe('sol@example.test');
    expect(command.calls).toEqual([
      { command: 'tailscale', args: ['version'] },
      { command: 'tailscale', args: ['status', '--json'] },
    ]);
  });

  it('returns Tailscale’s browser URL while authentication is pending', async () => {
    const needsLogin = JSON.stringify({ BackendState: 'NeedsLogin' });
    const command = runner([
      { code: 0, stdout: '1.90.6', stderr: '' },
      { code: 1, stdout: needsLogin, stderr: '' },
      {
        code: 1,
        stdout: 'To authenticate, visit:\n\nhttps://login.tailscale.com/a/abc_DEF-123\n',
        stderr: '',
      },
      { code: 1, stdout: needsLogin, stderr: '' },
    ]);

    const result = await installTailscale({ run: command.run, operator: 'beeline' });

    expect(result).toMatchObject({
      status: 'installing',
      signIn: {
        method: 'oauth',
        url: 'https://login.tailscale.com/a/abc_DEF-123',
        browserLocation: { kind: 'none' },
      },
    });
    expect(command.calls[2]).toEqual({
      command: 'sudo',
      args: ['-n', 'tailscale', 'up', '--timeout=10s', '--operator=beeline'],
    });
  });

  it('reports a bounded install failure instead of claiming a connection', async () => {
    const command = runner([
      { code: null, stdout: '', stderr: 'not found' },
      { code: 0, stdout: '', stderr: '' },
      { code: 1, stdout: '', stderr: 'sudo: a password is required' },
    ]);

    const result = await installTailscale({ run: command.run });

    expect(result).toMatchObject({
      status: 'error',
      errorMessage: 'sudo: a password is required',
      steps: [{ label: 'Tailscale installed', status: 'failed' }],
    });
    expect(command.calls[1]?.command).toBe('curl');
    expect(command.calls[2]?.command).toBe('sh');
  });

  it('reuses an open login ceremony while polling instead of running up again', async () => {
    const signIn = {
      method: 'oauth' as const,
      url: 'https://login.tailscale.com/a/still-open',
    };
    const command = runner([
      { code: 0, stdout: '1.90.6', stderr: '' },
      { code: 1, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }), stderr: '' },
    ]);

    const result = await installTailscale({ run: command.run, signIn });

    expect(result).toMatchObject({ status: 'installing', signIn });
    expect(command.calls).toHaveLength(2);
  });
});
