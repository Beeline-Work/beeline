import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSquire, type SquireConnectReport } from './connector-squire.js';
import { squireReachCause } from './squire-status.js';

afterEach(() => vi.unstubAllEnvs());

describe('Squire expired sign-in recovery', () => {
  it('opens a fresh external ceremony after expiry and reads the new account after completion', async () => {
    vi.stubEnv('BEELINE_HOSTED_SERVICES', '0');
    const unbound = new Error('list_credentials failed: {"error":{"code":"reconnect_required","message":"private provider details"}}');
    let accountReady = false;
    let connectionReady = false;
    const mcp = {
      reconnect: vi.fn(() => { connectionReady = accountReady; }),
      call: vi.fn(async () => {
        if (!connectionReady) throw unbound;
        return { credentials: [] };
      }),
    };
    const signIn = (url: string): SquireConnectReport => ({
      state: 'needs-sign-in', terminal: false, reason: null, sign_in_url: url,
      account: null, holder: null, browser_location: { kind: 'unknown', reason: 'external browser' },
    });
    const reports: SquireConnectReport[] = [
      signIn('https://trustysquire.ai/install?token=expired'),
      { ...signIn(''), state: 'blocked', terminal: true, reason: 'install_expired', sign_in_url: null },
      signIn('https://trustysquire.ai/install?token=fresh'),
      { ...signIn(''), state: 'connected', terminal: true, sign_in_url: null,
        account: { id: 'test-account', providers: [] } },
    ];
    const streamRun = vi.fn(async () => ({ stdout: '', stderr: '', abort: () => {}, report: reports.shift()! }));
    const install = () => installSquire({ workspaceId: 'expiry-test', mcp, streamRun,
      run: async () => ({ code: 0, stdout: '1.1.39', stderr: '' }) });

    const first = await install();
    expect(first).toMatchObject({ status: 'installing', signIn: {
      method: 'oauth', url: 'https://trustysquire.ai/install?token=expired' } });
    const expired = await install();
    expect(expired).toMatchObject({ status: 'error' });
    expect(expired).not.toHaveProperty('signIn');
    const fresh = await install();
    expect(fresh).toMatchObject({ status: 'installing', signIn: {
      method: 'oauth', url: 'https://trustysquire.ai/install?token=fresh' } });
    expect(streamRun).toHaveBeenCalledTimes(3);
    accountReady = true;
    expect(await install()).toMatchObject({ status: 'connected' });
    expect(mcp.reconnect).toHaveBeenCalledTimes(4);
    expect(streamRun).toHaveBeenCalledTimes(4);
    expect(await mcp.call()).toEqual({ credentials: [] });
    expect(squireReachCause(unbound)).toBe('Squire account sign-in required');
  });
});
