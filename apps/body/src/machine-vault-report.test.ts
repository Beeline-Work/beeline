import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommand, PostConnectorVaultInput, VaultConnectionMeta } from '@beeline/api-contract/daemon';
import { DaemonApiClient } from './daemon-api-client.js';
import { MachineLink } from './machine-link.js';
import { SquireTaskRelay } from './squire-task-relay.js';
import type { StdioSquireMcpClient } from './squire-mcp-client.js';

type Report = Omit<PostConnectorVaultInput, 'agentId'>;
class Socket extends EventEmitter {
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  frames: Record<string, any>[] = [];
  refuseReport = false;
  holdVault = false;
  receive(frame: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const frame = JSON.parse(raw);
    this.frames.push(frame);
    if (frame.type === 'register') this.receive({ type: 'registered', agentId: frame.agentId,
      capabilities: { daemonOperationsV1: true } });
    if (frame.type === 'daemon-operation' && !(this.holdVault && frame.operation === 'postConnectorVault')) this.receive({ type: 'daemon-operation-result',
      agentId: frame.agentId, requestId: frame.requestId,
      ...(this.refuseReport && frame.operation === 'postConnectorVault'
        ? { error: 'unavailable', status: 503 } : { result: { id: frame.operation, createdAt: 1 } }) });
  }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  terminate() { this.close(); }
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function fixture(count: number, readVault = vi.fn<() => Promise<Report>>(async () => ({ connections: [] }))) {
  const sockets: Socket[] = [];
  const log = vi.fn();
  const machine = new MachineLink({ baseUrl: 'http://synthetic.invalid', readVault, log,
    factory: () => {
      const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket;
    } });
  const fetcher = vi.fn(async () => { throw new Error('unexpected HTTP'); });
  const agents = Array.from({ length: count }, (_, i) => new DaemonApiClient(
    'http://synthetic.invalid', 'token', `agent-${i}`, fetcher, undefined, undefined, undefined, machine));
  cleanups.push(() => { for (const agent of agents) agent.closeLive(); machine.stop(); });
  const reads = agents.map(agent => agent.execute('getAgentConfiguration', { agentId: agent.agentId }));
  sockets[0]!.open();
  await Promise.all(reads);
  const reports = () => sockets.flatMap(socket => socket.frames).filter(frame => frame.operation === 'postConnectorVault');
  await vi.waitFor(() => expect(reports()).toHaveLength(1));
  const reconnect = async () => {
    machine.reconnectNow(); sockets.at(-1)!.open();
    await new Promise<void>(done => setImmediate(done));
  };
  return { machine, sockets, agents, fetcher, log, reports, reconnect, readVault };
}
const credential = (reference: string): VaultConnectionMeta => ({ reference, service: 'example', label: reference,
  fieldNames: ['password', 'username'], allowedHosts: ['b.example', 'a.example'], createdAt: 1,
  stale: false, state: 'active' });

describe('machine-owned vault reports', () => {
  it.each([1, 17])('sends one initial report for %i agents and none on unchanged reconnects', async count => {
    const { reports, reconnect, readVault, fetcher } = await fixture(count);
    expect(reports()).toHaveLength(1);
    expect(readVault).toHaveBeenCalledOnce();
    await reconnect();
    await reconnect();
    expect(reports()).toHaveLength(1);
    expect(readVault).toHaveBeenCalledTimes(3);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends exactly one changed list on reconnect across 17 agents and nothing on the second reconnect', async () => {
    const readVault = vi.fn<() => Promise<Report>>(async () => ({ connections: [] }));
    const { reports, reconnect } = await fixture(17, readVault);
    readVault.mockResolvedValue({ connections: [credential('new')] });
    await reconnect();
    expect(reports()).toHaveLength(2);
    expect(reports()[1]!.input.connections).toEqual([credential('new')]);
    await reconnect();
    expect(reports()).toHaveLength(2);
  });

  it('shares explicit refreshes, ignores ordering, and reports deletions and metadata changes', async () => {
    const a = credential('a'), b = credential('b');
    const readVault = vi.fn<() => Promise<Report>>(async () => ({ connections: [a, b] }));
    const { machine, agents, reports } = await fixture(17, readVault);
    readVault.mockResolvedValue({ connections: [b, { ...a, fieldNames: [...a.fieldNames].reverse(),
      allowedHosts: [...a.allowedHosts].reverse() }] });
    await Promise.all(agents.map(agent => agent.refreshMachineVault()));
    expect(reports()).toHaveLength(1);
    expect(readVault).toHaveBeenCalledTimes(3);
    readVault.mockResolvedValue({ connections: [a] });
    await machine.refreshVault();
    readVault.mockResolvedValue({ connections: [{ ...a, label: 'renamed' }] });
    await machine.refreshVault();
    readVault.mockResolvedValue({ connections: [] });
    await machine.refreshVault();
    expect(reports()).toHaveLength(4);
  });

  it('keeps agent operations independent of a slow vault read and uses a surviving registration', async () => {
    let resolve!: (report: Report) => void;
    const readVault = vi.fn<() => Promise<Report>>(async () => ({ connections: [] }));
    const { machine, agents, reports } = await fixture(2, readVault);
    readVault.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const refresh = machine.refreshVault();
    agents[0]!.closeLive();
    await expect(agents[1]!.execute('listRooms', { agentId: agents[1]!.agentId })).resolves.toMatchObject({ id: 'listRooms' });
    resolve({ connections: [credential('new')] });
    await refresh;
    expect(reports()).toHaveLength(2);
    expect(reports()[1]!.agentId).toBe(agents[1]!.agentId);
  });

  it('observes a local vault change that arrives while the previous report is pending', async () => {
    const { machine, sockets, readVault, reports } = await fixture(1);
    const socket = sockets[0]!;
    socket.holdVault = true;
    readVault.mockResolvedValue({ connections: [credential('new')] });
    const first = machine.refreshVault();
    await vi.waitFor(() => expect(reports()).toHaveLength(2));
    readVault.mockResolvedValue({ connections: [] });
    const changed = machine.refreshVault();
    socket.holdVault = false;
    const frame = reports()[1]!;
    socket.receive({ type: 'daemon-operation-result', agentId: frame.agentId,
      requestId: frame.requestId, result: { id: 'report', createdAt: 1 } });
    await Promise.all([first, changed]);
    expect(reports()).toHaveLength(3);
    expect(reports()[2]!.input.connections).toEqual([]);
  });

  it('preserves the last broker verdict on a failed read until the next ordinary observation', async () => {
    const { machine, readVault, reports, log } = await fixture(1);
    readVault.mockRejectedValueOnce(new Error('Squire MCP session closed'));
    await machine.refreshVault();
    expect(log).toHaveBeenCalledOnce();
    expect(reports()).toHaveLength(1);
    readVault.mockResolvedValue({ connections: [credential('new')] });
    await machine.refreshVault();
    expect(reports()).toHaveLength(2);
    expect(reports().some(frame => frame.input.errorMessage)).toBe(false);
  });

  it('does not remember failed deliveries or retry them without an ordinary refresh', async () => {
    const { machine, sockets, readVault, reports, log } = await fixture(1);
    readVault.mockResolvedValue({ connections: [credential('new')] });
    sockets[0]!.refuseReport = true;
    await machine.refreshVault();
    expect(reports()).toHaveLength(2);
    expect(log).toHaveBeenCalledOnce();
    sockets[0]!.refuseReport = false;
    await machine.refreshVault();
    expect(reports()).toHaveLength(3);
    await machine.refreshVault();
    expect(reports()).toHaveLength(3);
  });
});


it('refreshes the shared machine observation through local Squire activity without per-agent reports', async () => {
  const { machine, readVault, reports, agents } = await fixture(2);
  const requestMcp = vi.fn(async () => ({ content: [{ type: 'text', text: '{"credentials":[]}' }] }));
  const relay = new SquireTaskRelay(agents[0]!.agentId, 'room', '', async () => true, '',
    () => ({ requestMcp, close: () => {} }) as unknown as StdioSquireMcpClient,
    undefined, undefined, undefined, undefined, undefined, () => machine.refreshVault());
  cleanups.push(() => relay.close());
  relay.activate({ agentId: agents[0]!.agentId, roomId: 'room', turnRequestId: 'request',
    rootCommandId: 'task' } as AgentCommand, 'generation');
  const { url, token } = await relay.listen();
  const call = async (tool: string) => {
    const response = await fetch(`${url}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room', requestId: 'request', taskId: 'task', generationId: 'generation',
        method: 'tools/call', params: { name: tool, arguments: {} } }) });
    expect(response.status).toBe(200);
    return response.json();
  };
  readVault.mockResolvedValue({ connections: [credential('new')] });
  await call('list_credentials');
  expect(reports()).toHaveLength(2);
  await call('list_credentials');
  expect(reports()).toHaveLength(2);
  readVault.mockResolvedValue({ connections: [] });
  await call('delete_credential');
  expect(reports()).toHaveLength(3);
  requestMcp.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'unavailable' }] } as never);
  const reads = readVault.mock.calls.length;
  await call('list_credentials');
  expect(readVault).toHaveBeenCalledTimes(reads);
});
