import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as { op: string; input: Record<string, unknown> }[],
  readWorkbenchOutput: {} as Record<string, unknown>,
}));

vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: async (op: string, input: Record<string, unknown>) => {
    state.calls.push({ op, input });
    if (op === 'readWorkbench') return state.readWorkbenchOutput;
    if (op === 'pairConnector') return { connectorId: 'conn-1' };
    return {};
  },
}));

import { MonolithWorkbenchSource } from './workbench-source';

/** A readWorkbench DTO whose Google rows carry the given statuses. */
function workbenchDto(googleRows: { connectorType: string; status: string }[]) {
  return {
    helpers: [],
    catalog: [
      { connectorType: 'trusty-squire', name: 'Trusty Squire', available: true },
      { connectorType: 'google-gmail', name: 'Gmail', available: true },
      { connectorType: 'google-calendar', name: 'Google Calendar', available: true },
      { connectorType: 'google-drive', name: 'Google Drive', available: true },
      { connectorType: 'google-youtube', name: 'YouTube', available: true },
    ],
    connectors: googleRows.map((row) => ({
      connectorId: `conn-${row.connectorType}`,
      connectorType: row.connectorType,
      status: { status: row.status, steps: [], signIn: null },
    })),
    connections: [],
  };
}

describe('MonolithWorkbenchSource pairConnector — the ONE Google entry', () => {
  afterEach(() => {
    state.calls.length = 0;
  });

  it('resolves the logical google id to the first unconnected tool', async () => {
    state.readWorkbenchOutput = workbenchDto([]);
    const result = await new MonolithWorkbenchSource().pairConnector({
      workspaceId: 'ws1',
      connectorId: 'google',
      helperId: 'helper-1',
    });
    expect(result).toEqual({ connectorId: 'conn-1' });
    const pair = state.calls.find((call) => call.op === 'pairConnector')!;
    expect(pair.input.connectorType).toBe('google-gmail');
    expect(pair.input.helperAgentId).toBe('helper-1');
  });

  it('tops up the first missing tool when part of the set is already connected', async () => {
    state.readWorkbenchOutput = workbenchDto([
      { connectorType: 'google-gmail', status: 'connected' },
      { connectorType: 'google-calendar', status: 'connected' },
    ]);
    await new MonolithWorkbenchSource().pairConnector({
      workspaceId: 'ws1',
      connectorId: 'google',
      helperId: 'helper-1',
    });
    expect(
      state.calls.find((call) => call.op === 'pairConnector')!.input.connectorType,
    ).toBe('google-drive');
  });

  it('passes concrete connector ids through without a catalog read', async () => {
    state.readWorkbenchOutput = workbenchDto([]);
    await new MonolithWorkbenchSource().pairConnector({
      workspaceId: 'ws1',
      connectorId: 'trusty-squire',
      helperId: 'helper-1',
    });
    expect(
      state.calls.find((call) => call.op === 'pairConnector')!.input.connectorType,
    ).toBe('trusty-squire');
    expect(state.calls.some((call) => call.op === 'readWorkbench')).toBe(false);
  });
});

describe('MonolithWorkbenchSource connections', () => {
  afterEach(() => {
    state.calls.length = 0;
  });

  it('carries the vault service through as itself, and leaves it absent when the vault has none', async () => {
    state.readWorkbenchOutput = {
      ...workbenchDto([]),
      connections: [
        {
          reference: 'cred_github',
          label: 'Work key',
          service: 'github',
          allowedHosts: [],
          faviconDomain: null,
          state: 'active',
        },
        {
          reference: 'cred_unknown',
          label: 'Box',
          service: null,
          allowedHosts: ['127.0.0.1'],
          faviconDomain: null,
          state: 'active',
        },
        {
          reference: 'cred_resend',
          label: 'default',
          service: 'resend',
          allowedHosts: ['api.resend.com'],
          faviconDomain: 'resend.com',
          state: 'active',
        },
      ],
    };
    const view = await new MonolithWorkbenchSource().readWorkbench({
      workspaceId: 'ws1',
      viewerId: 'human-dani',
    });
    expect(view.connections[0].service).toBe('github');
    expect(view.connections[1].service).toBeUndefined();
    // The server-derived brand domain rides through for the mark to fetch.
    expect(view.connections[2].faviconDomain).toBe('resend.com');
    expect(view.connections[0].faviconDomain).toBeUndefined();
  });
});
