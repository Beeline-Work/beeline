import { describe, expect, it } from 'vitest';
import {
  connectionCreatedByLine,
  connectionGrantsLine,
  connectionHostsLine,
  connectionsForViewer,
  connectorDescription,
  connectorIdentityHandle,
  connectorIdentityId,
  connectorRowValue,
  isConnectorIdentityId,
  type ConnectionDetailView,
  type WorkbenchView,
} from './workbench';

const VIEWER_A = 'human-dani';
const VIEWER_B = 'human-terra';

const view: WorkbenchView = {
  connectors: [
    {
      id: 'trusty-squire',
      name: 'Trusty Squire',
      description: 'vault · sign-ups · payments for your agents',
      available: true,
    },
    { id: 'wallet', name: 'Wallet', description: 'crypto wallet for agents', available: false },
  ],
  connections: [
    {
      ref: 'cred_vercel',
      name: 'Vercel',
      kind: 'token',
      hosts: ['api.vercel.com'],
      state: 'active',
      ownerId: VIEWER_A,
    },
    {
      ref: 'cred_google',
      name: 'Google',
      kind: 'session',
      hosts: [],
      state: 'active',
      ownerId: VIEWER_A,
    },
    {
      ref: 'cred_slack',
      name: 'Slack',
      kind: 'token',
      hosts: ['slack.com'],
      state: 'error',
      ownerId: VIEWER_B,
    },
  ],
};

describe('Workbench sovereignty', () => {
  it('shows member A only their own connections', () => {
    expect(connectionsForViewer(view, VIEWER_A).map((connection) => connection.ref)).toEqual([
      'cred_vercel',
      'cred_google',
    ]);
  });

  it('shows member B none of member A connections', () => {
    const memberB = connectionsForViewer(view, VIEWER_B);
    expect(memberB.map((connection) => connection.ref)).toEqual(['cred_slack']);
    expect(memberB.some((connection) => connection.ownerId === VIEWER_A)).toBe(false);
  });

  it('shows an unknown viewer nothing', () => {
    expect(connectionsForViewer(view, 'human-nobody')).toEqual([]);
  });
});

describe('connector row copy', () => {
  it('names soon connectors and never lets them act', () => {
    expect(connectorRowValue(view.connectors[1])).toBe('soon');
    expect(view.connectors[1].available).toBe(false);
  });

  it('offers connect while disconnected', () => {
    expect(connectorRowValue(view.connectors[0])).toBe('connect');
  });

  it('describes a connected connector by what it runs on', () => {
    expect(
      connectorDescription({
        ...view.connectors[0],
        status: 'connected',
        helperName: 'squire-box',
        agentCount: 3,
        signedInAs: 'dani@…',
      }),
    ).toBe('on squire-box · 3 agents · signed in as dani@…');
  });

  it('keeps the plain description while disconnected', () => {
    expect(connectorDescription(view.connectors[0])).toBe(
      'vault · sign-ups · payments for your agents',
    );
  });
});

const detail: ConnectionDetailView = {
  connection: view.connections[0],
  createdBy: { handle: '@hoots', cause: 'sign-up', at: '13 Sep' },
  grants: [
    { agent: 'hoots', kinds: ['deploy', 'list'] },
    { agent: 'terra', kinds: ['list'] },
  ],
  spendCap: 'none',
  ledger: [],
};

describe('connection detail copy', () => {
  it('joins hosts and dashes an empty session list', () => {
    expect(connectionHostsLine(detail.connection)).toBe('api.vercel.com');
    expect(connectionHostsLine(view.connections[1])).toBe('—');
  });

  it('reads who created the connection and why', () => {
    expect(connectionCreatedByLine(detail)).toBe('@hoots · sign-up · 13 Sep');
  });

  it('prints grants with their kinds, and none when empty', () => {
    expect(connectionGrantsLine(detail)).toBe('hoots (deploy, list) · terra (list)');
    expect(connectionGrantsLine({ ...detail, grants: [] })).toBe('none');
  });
});

describe('connector identity', () => {
  it('names the hidden connector identity that sends receipt DMs', () => {
    expect(connectorIdentityHandle('trusty-squire')).toBe('@trusty-squire');
    expect(isConnectorIdentityId(connectorIdentityId('trusty-squire'))).toBe(true);
  });

  it('does not mistake ordinary identities for connectors', () => {
    expect(isConnectorIdentityId('agent-123')).toBe(false);
    expect(isConnectorIdentityId(undefined)).toBe(false);
  });
});
