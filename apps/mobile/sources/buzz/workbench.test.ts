import { describe, expect, it } from 'vitest';
import {
  connectionCompany,
  connectionCreatedByLine,
  connectionDomainsLine,
  connectionGrantsLine,
  connectionHostsLine,
  connectionInstrument,
  connectionSpendCap,
  connectionsForViewer,
  connectorDescription,
  connectorIdentityHandle,
  connectorIdentityId,
  connectorInstrument,
  GOOGLE_BLOCKED_ON_SQUIRE_LINE,
  googleBlockedOnSquireBrowser,
  googleEntryConnector,
  googleEntryDescription,
  googleEntryState,
  isConnectorIdentityId,
  isGoogleToolConnectorId,
  isSquireBrowserSessionFailure,
  ledgerBytes,
  ledgerStamp,
  resolveGoogleConnectTarget,
  serviceMonogram,
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
      description:
        'With Trusty Squire, just by linking your Google account, B-Line agents can sign up for software services for you without you having to be involved.',
      available: true,
    },
    { id: 'wallet', name: 'Wallet', description: 'crypto wallet for agents', available: false },
  ],
  connections: [
    {
      ref: 'cred_vercel',
      name: 'Vercel',
      service: 'vercel',
      hosts: ['api.vercel.com'],
      state: 'active',
      ownerId: VIEWER_A,
    },
    {
      ref: 'cred_google',
      name: 'Google',
      service: 'google',
      hosts: [],
      state: 'active',
      ownerId: VIEWER_A,
    },
    {
      ref: 'cred_slack',
      name: 'Slack',
      service: 'slack',
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
  it('reads soon connectors and never lets them act', () => {
    expect(connectorInstrument('soon')).toEqual({ value: 'soon', connect: false });
    expect(view.connectors[1].available).toBe(false);
  });

  it('reads a disconnected connector as its Connect button, no state word', () => {
    expect(connectorInstrument(undefined)).toEqual({ connect: true });
    expect(connectorInstrument('disconnected')).toEqual({ connect: true });
  });

  it('reads the settled, in-flight and broken states with their dots', () => {
    expect(connectorInstrument('connected')).toEqual({
      value: 'connected',
      glyph: 'live',
      connect: false,
    });
    expect(connectorInstrument('installing')).toEqual({
      value: 'installing',
      glyph: 'pulse',
      valueTone: 'accent',
      connect: false,
    });
    expect(connectorInstrument('error')).toEqual({
      connect: true,
    });
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

  it('keeps the user-story description while disconnected', () => {
    expect(connectorDescription(view.connectors[0])).toBe(
      'With Trusty Squire, just by linking your Google account, B-Line agents can sign up for software services for you without you having to be involved.',
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

describe('key row copy', () => {
  it('puts the domains under the name and leaves a hostless key no quiet line', () => {
    expect(connectionDomainsLine(view.connections[0])).toBe('api.vercel.com');
    expect(connectionDomainsLine(view.connections[1])).toBe('');
  });

  it('names the company from the service the vault reports', () => {
    expect(connectionCompany(view.connections[0])).toBe('vercel');
    expect(connectionCompany(view.connections[1])).toBe('google');
  });

  it('keeps the service over a label and an address that disagree with it', () => {
    // The case the label would get wrong: a GitHub key someone called
    // `Work key`, with no hosts to read either.
    const labelled = { ...view.connections[0], name: 'Work key', service: 'github', hosts: [] };
    expect(connectionCompany(labelled)).toBe('github');
    expect(serviceMonogram(connectionCompany(labelled))).toBe('G');
    // And an address that is not its company's name at all.
    const proxied = { ...view.connections[0], service: 'openai', hosts: ['10.0.0.7'] };
    expect(connectionCompany(proxied)).toBe('openai');
  });

  it('falls back to the host, then the name, only when no service is reported', () => {
    const noService = (hosts: string[], name = 'Vercel') => ({
      ...view.connections[0],
      name,
      service: undefined,
      hosts,
    });
    expect(connectionCompany(noService(['api.vercel.com']))).toBe('vercel');
    expect(connectionCompany(noService(['slack.com']))).toBe('slack');
    // A two-level suffix is not the company: `co.uk` used to read as `co`.
    expect(connectionCompany(noService(['api.example.co.uk']))).toBe('example');
    // An address names no company — the key's own name says more.
    expect(connectionCompany(noService(['127.0.0.1'], 'Home box'))).toBe('Home box');
    expect(connectionCompany(noService([], 'Home box'))).toBe('Home box');
  });

  it('carries the company letter on the mark, and never an empty plate', () => {
    expect(serviceMonogram('vercel')).toBe('V');
    expect(serviceMonogram('1password')).toBe('1');
    expect(serviceMonogram('@slack')).toBe('S');
    expect(serviceMonogram('')).toBe('?');
    // One glyph, always: `ß` upper-cases to `SS`.
    expect(serviceMonogram('ßeta')).toBe('S');
  });

  it('reads a live key and a broken one apart, each with its dot', () => {
    expect(connectionInstrument('active')).toEqual({ value: 'active', glyph: 'live' });
    expect(connectionInstrument('error')).toEqual({
      value: 'error',
      glyph: 'failed',
      valueTone: 'danger',
    });
  });
});

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
  const tool = (
    id: WorkbenchConnectorId,
    status?: WorkbenchConnectorStatus,
  ): WorkbenchConnector => ({
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
    expect(
      googleEntryState(
        catalog.map((c) => (c.id === 'google-gmail' ? tool('google-gmail', 'connected') : c)),
      ),
    ).toBe('repair');
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
      googleEntryState(
        catalog.map((c) =>
          isGoogleToolConnectorId(c.id) ? { ...c, status: 'connected' as const } : c,
        ),
      ),
    ).toBe('connected');
  });

  it('describes a repair as how much of the one grant is live', () => {
    const repaired = catalog.map((c) =>
      c.id === 'google-gmail' || c.id === 'google-calendar' ? tool(c.id, 'connected') : c,
    );
    expect(googleEntryDescription(repaired, googleEntryState(repaired))).toBe(
      '2 of 4 tools connected',
    );
    expect(googleEntryDescription(catalog, 'connect')).toBe(
      'Covers Gmail, Google Calendar, YouTube, and other Google services.',
    );
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
    expect(
      resolveGoogleConnectTarget(catalog.map((c) => ({ ...c, status: 'connected' as const }))),
    ).toBe('google-gmail');
  });

  it('does not treat a Trusty Squire browser-session failure as Google’s own breakage', () => {
    const busy =
      'another Trusty Squire session is already using the browser - close it first';
    expect(isSquireBrowserSessionFailure(busy)).toBe(true);
    const bled = [
      { ...tool('trusty-squire'), status: 'error' as const, errorMessage: busy },
      { ...tool('google-gmail'), status: 'error' as const, errorMessage: busy },
      tool('google-calendar'),
      tool('google-drive'),
      tool('google-youtube'),
    ];
    expect(googleEntryState(bled)).toBe('connect');
    expect(googleBlockedOnSquireBrowser(bled)).toBe(true);
    expect(googleEntryDescription(bled, googleEntryState(bled))).toBe(
      GOOGLE_BLOCKED_ON_SQUIRE_LINE,
    );
    const entry = googleEntryConnector(bled);
    expect(entry?.status).toBe('disconnected');
    expect(entry?.errorMessage).toBeUndefined();
  });

  it('still reports a genuine Google error as Google’s own', () => {
    const failed = [
      tool('trusty-squire', 'connected'),
      { ...tool('google-gmail'), status: 'error' as const, errorMessage: 'scope refused' },
      tool('google-calendar'),
      tool('google-drive'),
      tool('google-youtube'),
    ];
    expect(googleEntryState(failed)).toBe('error');
    expect(googleBlockedOnSquireBrowser(failed)).toBe(false);
    expect(googleEntryConnector(failed)?.errorMessage).toBe('scope refused');
  });
});
