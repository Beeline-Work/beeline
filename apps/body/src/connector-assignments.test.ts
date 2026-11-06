import { describe, expect, it, vi } from 'vitest';
import { ConnectorAssignmentLoop } from './connector-assignments.js';

describe('connector assignment vault ownership', () => {
  it('never reads or reports a vault on per-agent startup and reconnect drains', async () => {
    const execute = vi.fn(async () => ({ assignments: [] }));
    const refreshVault = vi.fn(async () => {});
    const loop = new ConnectorAssignmentLoop({ agentId: 'agent', api: { execute: execute as never }, refreshVault });
    await loop.runOnce();
    await loop.runOnce();
    expect(execute.mock.calls).toEqual([
      ['getConnectorAssignments', { agentId: 'agent' }],
      ['getConnectorAssignments', { agentId: 'agent' }],
    ]);
    expect(refreshVault).not.toHaveBeenCalled();
    loop.stop();
  });

  it('asks the machine owner to refresh for an explicit sync assignment', async () => {
    const execute = vi.fn(async () => ({ assignments: [{ kind: 'sync', connectorId: 'squire:machine', connectorType: 'trusty-squire' }] }));
    const refreshVault = vi.fn(async () => {});
    const loop = new ConnectorAssignmentLoop({ agentId: 'agent', api: { execute: execute as never }, refreshVault });
    await loop.runOnce();
    expect(refreshVault).toHaveBeenCalledOnce();
    expect(execute.mock.calls).toEqual([['getConnectorAssignments', { agentId: 'agent' }]]);
    loop.stop();
  });
});
