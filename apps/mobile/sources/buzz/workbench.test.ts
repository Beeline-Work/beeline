import { describe, expect, it } from 'vitest';
import {
  connectionCreatedByLine,
  connectionGrantsLine,
  connectionHostsLine,
  connectionSpendCap,
  connectionsForViewer,
  connectorDescription,
  connectorIdentityHandle,
  connectorIdentityId,
  connectorRowValue,
  googleEntryDescription,
  googleEntryState,
  isConnectorIdentityId,
  isGoogleToolConnectorId,
  ledgerBytes,
  ledgerStamp,
  resolveGoogleConnectTarget,
  type ConnectionDetailView,
  type WorkbenchConnector,
  type WorkbenchConnectorId,
  type WorkbenchConnectorStatus,
  type WorkbenchView,
} from './workbench';

const VIEWER_A = 'human-dani';
const VIEWER_B = 'human-terra';

const view: WorkbenchView = {
  connectors: [
    {
      id: 'trusty-squire',
      name: 'Trusty Squire',
      description: 'vault, sign-ups, payments',
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
      'vault, sign-ups, payments',
    );
  });
});

const detail: ConnectionDetailView = {
  connection: view.connections[0],
  createdBy: { handle: '@hoots', cause: 'sign-up', at: '13 Sep' },
  grants: [
    { grantId: 'hoots', createdAt: 1, spendCapUsd: 25 },
    { grantId: 'terra', createdAt: 2 },
  ],
  spendCap: '$25 cap',
  ledger: [],
};

describe('connection detail copy', () => {
  it('joins hosts and dashes an empty session list', () => {
    expect(connectionHostsLine(detail.connection)).toBe('api.vercel.com');
    expect(connectionHostsLine(view.connections[1])).toBe('—');
  });

  it('reads who created the connection and why, and omits the row when absent', () => {
    expect(connectionCreatedByLine(detail)).toBe('@hoots · sign-up · 13 Sep');
    expect(connectionCreatedByLine({ ...detail, createdBy: undefined })).toBe('');
  });

  it('counts live grants — the server carries no agent attribution', () => {
    expect(connectionGrantsLine(detail)).toBe('2 live grants');
    expect(connectionGrantsLine({ ...detail, grants: [{ grantId: 'hoots', createdAt: 1 }] })).toBe(
      '1 live grant',
    );
    expect(connectionGrantsLine({ ...detail, grants: [] })).toBe('none');
  });

  it('reports the tightest per-grant spend cap, or none', () => {
    expect(connectionSpendCap(detail.grants)).toBe('$25 cap');
    expect(connectionSpendCap([{ grantId: 'terra', createdAt: 2 }])).toBe('none');
  });

  it('stamps ledger rows today as a clock and older ones as a date', () => {
    const noon = new Date('2026-09-15T12:00:00').getTime();
    expect(ledgerStamp(new Date('2026-09-15T09:26:00').getTime(), noon)).toBe('09:26');
    expect(ledgerStamp(new Date('2026-09-13T09:26:00').getTime(), noon)).toBe('13 Sep');
    expect(ledgerBytes(1234)).toBe('1.2 kB');
    expect(ledgerBytes(80)).toBe('80 B');
    expect(ledgerBytes(0)).toBeUndefined();
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

describe('the ONE Google entry', () => {
  const tool = (id: WorkbenchConnectorId, status?: WorkbenchConnectorStatus): WorkbenchConnector => ({
    id,
    name: id,
    description: 'one Google OAuth grant for your agents',
    available: true,
    ...(status ? { status } : {}),
  });
  const catalog = [
    tool('trusty-squire'),
    tool('google-gmail'),
    tool('google-calendar'),
    tool('google-drive'),
    tool('google-youtube'),
  ];

  it('folds the four tools into one row that reports the worst severity across them', () => {
    expect(googleEntryState(catalog)).toBe('connect');
    expect(googleEntryState(catalog.map((c) => (c.id === 'google-gmail' ? tool('google-gmail', 'connected') : c)))).toBe('repair');
    expect(
      googleEntryState([
        tool('google-gmail', 'connected'),
        tool('google-calendar', 'error'),
        tool('google-drive'),
        tool('google-youtube'),
      ]),
    ).toBe('error');
    expect(
      googleEntryState([
        tool('google-gmail', 'installing'),
        tool('google-calendar', 'error'),
        tool('google-drive'),
        tool('google-youtube'),
      ]),
    ).toBe('installing');
    expect(
      googleEntryState(catalog.map((c) => (isGoogleToolConnectorId(c.id) ? { ...c, status: 'connected' as const } : c))),
    ).toBe('connected');
  });

  it('describes a repair as how much of the one grant is live', () => {
    const repaired = catalog.map((c) =>
      c.id === 'google-gmail' || c.id === 'google-calendar' ? tool(c.id, 'connected') : c,
    );
    expect(googleEntryDescription(repaired, googleEntryState(repaired))).toBe(
      '2 of 4 tools connected',
    );
    expect(googleEntryDescription(catalog, 'connect')).toBe('one Google OAuth grant for your agents');
  });

  it('resolves the connect target to the first unconnected tool in canonical order', () => {
    expect(resolveGoogleConnectTarget(catalog)).toBe('google-gmail');
    expect(
      resolveGoogleConnectTarget([
        tool('google-gmail', 'connected'),
        tool('google-calendar', 'connected'),
        tool('google-drive'),
        tool('google-youtube'),
      ]),
    ).toBe('google-drive');
    // Everything connected re-arms the first tool; the server keeps the
    // connected siblings' live grants.
    expect(resolveGoogleConnectTarget(catalog.map((c) => ({ ...c, status: 'connected' as const })))).toBe(
      'google-gmail',
    );
  });
});
