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
    expect(squireConnectionState(view)).toBe('offline');
  });
});
