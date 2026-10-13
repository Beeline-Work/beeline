import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { userInfo, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assertLifecycleTestIsolation } from './lifecycle-test-guard.js';
import { convergeNativeHelper } from './native-helper.js';

describe('lifecycle test isolation', () => {
  it('refuses the real user paths before writing a unit or calling a manager', async () => {
    const live = userInfo().homedir;
    const run = vi.fn();
    await expect(
      convergeNativeHelper({
        env: {
          HOME: live,
          XDG_CONFIG_HOME: resolve(live, '.config'),
          XDG_STATE_HOME: resolve(live, '.local/state'),
        },
        run,
      }),
    ).rejects.toThrow('real user');
    expect(run).not.toHaveBeenCalled();
  });
  it('refuses a symlink back to the real user install', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-guard-'));
    try {
      await symlink(userInfo().homedir, resolve(root, 'live'));
      expect(() =>
        assertLifecycleTestIsolation(
          {
            HOME: root,
            XDG_CONFIG_HOME: resolve(root, 'live/.config'),
            XDG_STATE_HOME: resolve(root, 'state'),
          },
          true,
        ),
      ).toThrow('real user');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refuses the actual user manager even with private install paths', () => {
    expect(() => assertLifecycleTestIsolation(process.env)).toThrow('mocked service manager');
    expect(() => assertLifecycleTestIsolation(process.env, true)).not.toThrow();
  });
});
