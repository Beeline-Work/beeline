import { createConnection, createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { HOST_EMULATOR_TARGET } from '@beeline/api-contract/agent-grants';
import { requestGrant, type AgentGrantDeps } from './read-only-mcp.js';
import { hostEmulatorSerials } from './machine-control.js';

const ask = { kind: 'host', target: HOST_EMULATOR_TARGET, purpose: 'Test the Android app', reason: 'Need the host emulator' };
const grant = { grantId: 'g1', kind: 'host', target: HOST_EMULATOR_TARGET, status: 'approved' };
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function deps(live: unknown[], history: unknown[], probe = vi.fn(async () => [] as string[])): AgentGrantDeps & { execute: ReturnType<typeof vi.fn>; hostEmulators: typeof probe } {
  return {
    roomId: 'room', hostEmulators: probe,
    execute: vi.fn(async (name: string) => {
      if (name === 'listAgentGrants') return { grants: live };
      if (name === 'listAgentGrantRequests') return { grants: history };
      if (name === 'requestAgentGrant') return { grantId: 'g1', auto: false, status: 'pending' };
      return {};
    }),
  };
}
async function adbFixture(devices: string, split = false) {
  const requests: string[] = [];
  const server = createServer(socket => {
    socket.once('data', chunk => {
      requests.push(chunk.toString());
      const reply = 'OKAY' + Buffer.byteLength(devices).toString(16).padStart(4, '0') + devices;
      if (split) { socket.write(reply.slice(0, 6)); socket.end(reply.slice(6)); }
      else socket.end(reply);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture has no address');
  const probe = vi.fn(() => hostEmulatorSerials(() => createConnection({ host: '127.0.0.1', port: address.port })));
  return { probe, requests };
}

describe('host emulator permission through request_grant', () => {
  it('no host emulator: tells the agent unavailable and starts nothing', async () => {
    const spawn = vi.spyOn(childProcess, 'spawn');
    const exec = vi.spyOn(childProcess, 'execFile');
    const fixture = await adbFixture('');
    const result = await requestGrant(ask, deps([grant], [], fixture.probe));
    expect(result).toContain('Host emulator unavailable');
    expect(result).toContain('say so in your reply');
    expect(fixture.requests).toEqual(['000chost:devices']);
    expect(spawn).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
  it('host emulator + permission: returns the existing address and ready serial', async () => {
    const fixture = await adbFixture('emulator-5554\tdevice\nusb-123\tdevice\nemulator-5556\toffline\n', true);
    const result = await requestGrant(ask, deps([grant], [], fixture.probe));
    expect(result).toContain('Host emulator allowed at 127.0.0.1:5037');
    expect(result).toContain('adb -H 127.0.0.1 -P 5037 -s emulator-5554');
    expect(result).not.toContain('usb-123');
    expect(result).not.toContain('emulator-5556');
    expect(fixture.requests).toEqual(['000chost:devices']);
  });
  it.each(['denied', 'revoked'])('permission %s: uses no emulator and does not probe the host', async status => {
    const dependencies = deps([], [{ ...grant, status }]);
    const result = await requestGrant(ask, dependencies);
    expect(result).toContain('Host emulator permission refused');
    expect(result).toContain('say so in your reply');
    expect(dependencies.hostEmulators).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalledWith('requestAgentGrant', expect.anything());
  });
  it('requests the existing human grant flow before probing', async () => {
    const dependencies = deps([], []);
    expect(await requestGrant(ask, dependencies)).toContain('pending, card posted');
    expect(dependencies.execute).toHaveBeenCalledWith('requestAgentGrant', { roomId: 'room', ...ask });
    expect(dependencies.hostEmulators).not.toHaveBeenCalled();
  });
  it('a reviewer does not mistake the implementer permission for its own', async () => {
    const dependencies = deps([], [{ ...grant, agentId: 'implementer', status: 'pending' }]);
    expect(await requestGrant(ask, dependencies)).toContain('pending, card posted');
    expect(dependencies.execute).toHaveBeenCalledWith('requestAgentGrant', { roomId: 'room', ...ask });
    expect(dependencies.hostEmulators).not.toHaveBeenCalled();
  });
  it('pending permission uses no emulator and does not post another card', async () => {
    const dependencies = deps([], [{ ...grant, status: 'pending' }]);
    expect(await requestGrant(ask, dependencies)).toContain('permission pending');
    expect(dependencies.hostEmulators).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalledWith('requestAgentGrant', expect.anything());
  });
  it('a missing host adb server is unavailable without launching one', async () => {
    const probe = vi.fn(async (): Promise<string[]> => { throw new Error('ECONNREFUSED'); });
    expect(await requestGrant(ask, deps([grant], [], probe))).toContain('Host emulator unavailable');
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it('spends a once permission before delivering the address', async () => {
    const dependencies = deps([{ ...grant, status: 'once' }], [], vi.fn(async () => ['emulator-5554']));
    expect(await requestGrant(ask, dependencies)).toContain('Host emulator allowed');
    expect(dependencies.execute).toHaveBeenLastCalledWith('consumeAgentGrant', { grantId: 'g1' });
  });
});
