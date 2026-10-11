import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpResourceScope } from './acp-resource-scope.js';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe('ACP scopes during managed startup', () => {
  it.each(['beeline-helper.service', `beeline-agent@${'a'.repeat(64)}.service`])(
    'can start before %s announces READY, while retaining lifetime binding',
    (owner) => {
      vi.stubEnv('BEELINE_MANAGED_BY_SYSTEMD', '1');
      vi.mocked(readFileSync).mockReturnValue(`0::/user.slice/user@1000.service/app.slice/${owner}\n`);
      const launch = new AcpResourceScope().launch('codex-acp', [], { PATH: '/usr/bin' });
      expect(launch.args).toContain(`--property=BindsTo=${owner}`);
      // Type=notify owners wait for a served ACP update probe before READY.
      // An After=owner ordering edge makes that probe wait for its own READY,
      // so initialize times out even when the harness is healthy.
      expect(launch.args.some((arg) => arg.startsWith('--property=After='))).toBe(false);
      expect(launch.args).toContain('--property=KillMode=control-group');
    },
  );

  it('does not bind an unmanaged session to a helper', () => {
    vi.stubEnv('BEELINE_MANAGED_BY_SYSTEMD', '0');
    const launch = new AcpResourceScope().launch('codex-acp', [], {});
    expect(launch.args.some((arg) => arg.startsWith('--property=BindsTo='))).toBe(false);
    expect(readFileSync).not.toHaveBeenCalled();
  });
});
