import { describe, expect, it } from 'vitest';
import { keyServiceGroups, squireConnectionState } from './connectors-model';
import type { WorkbenchView } from './workbench';

const key = (ref: string, service: string, label: string) => ({
  connectionId: `${ref}-${label}`, ref, service, name: label, hosts: [`api.${service}.com`],
  state: 'active' as const, ownerId: 'owner',
});

describe('Connectors key projection', () => {
  it('shows one service with distinct labels once across repeated helper reports', () => {
    const view: WorkbenchView = {
      connectors: [], helpers: [], apps: [{ id: 'app', key: 'openrouter', name: 'OpenRouter',
        transport: 'squire-api', status: 'connected', useCount: 0,
        connectionReference: 'vault://openrouter/default' }],
      connections: [key('vault://openrouter/default', 'openrouter', 'default'),
        key('vault://openrouter/beeline', 'openrouter', 'beeline'),
        key('vault://openrouter/default', 'openrouter', 'default')],
    };
    expect(keyServiceGroups(view, 'owner')).toEqual([expect.objectContaining({
      name: 'OpenRouter', keys: [view.connections[0], view.connections[1]],
    })]);
    expect(squireConnectionState(view)).toBe('never');
  });
  it('uses machine broker reports instead of connector rows or cached keys', () => {
    const view: WorkbenchView = { connectors: [{ id: 'trusty-squire', name: 'Trusty Squire',
      description: '', available: true, status: 'connected' }], helpers: [], apps: [], connections: [] };
    expect(squireConnectionState(view)).toBe('never');
    view.helpers = [{ id: 'machine', name: 'Machine', online: true,
      squire: { status: 'error', errorMessage: 'Squire broker unavailable', reportedAt: 1 } }];
    expect(squireConnectionState(view)).toBe('offline');
    view.helpers = [{ id: 'machine', name: 'Machine', online: true,
      squire: { status: 'connected', reportedAt: 2 } }];
    expect(squireConnectionState(view)).toBe('connected');
  });
});
