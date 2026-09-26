import {
  CONNECTOR_DESCRIPTIONS,
  GOOGLE_CONNECTOR_ORDER,
  GOOGLE_ENTRY_ID,
  resolveGoogleConnectTarget,
  type ConnectionDetailView,
  type ConnectorInstallState,
  type WorkbenchApp,
  type WorkbenchConnector,
  type WorkbenchHelper,
  type WorkbenchView,
} from './workbench';
import type { WorkbenchSource } from './workbench-source';

/**
 * Test-support mock of the Workbench data source. The screens and tests
 * import `getWorkbenchSource()` from `workbench-source.ts`, whose DEFAULT is
 * the real monolith source; tests install this mock through
 * `setWorkbenchSource()`. It is NOT imported by any screen, so Metro never
 * bundles it.
 */
type MockViewer = {
  id: string;
  name: string;
  connections: ConnectionDetailView[];
};

const MEMBER_A = 'human-dani';
const MEMBER_B = 'human-terra';

export const VERCEL_CONNECTION: ConnectionDetailView = {
  connection: {
    ref: 'cred_vercel',
    name: 'Vercel',
    service: 'vercel',
    hosts: ['api.vercel.com'],
    fieldNames: ['token'],
    faviconDomain: 'vercel.com',
    state: 'active',
    createdAt: 1_757_721_600,
    lastSyncedAt: 1_757_808_000,
    ownerId: MEMBER_A,
    grantCount: 2,
  },
  createdBy: { handle: '@hoots', cause: 'sign-up', at: '13 Sep' },
  grants: [
    { grantId: 'hoots', createdAt: 1, spendCapUsd: 25 },
    { grantId: 'terra', createdAt: 2 },
  ],
  spendCap: '$25 cap',
  ledger: [
    { at: '14:26', actor: '@hoots', action: 'deploy', status: '200', bytes: '1.2 kB' },
    { at: '14:19', actor: '@hoots', action: 'deploy', status: '200', bytes: '0.9 kB' },
    { at: '13:41', actor: '@terra', action: 'list projects', status: '200' },
    { at: '13:40', actor: '', action: 'grant minted for @terra' },
    { at: '12:02', actor: '', action: 'credential stored by @hoots (sign-up)' },
  ],
};

export const GOOGLE_CONNECTION: ConnectionDetailView = {
  connection: {
    ref: 'cred_google',
    name: 'Google',
    service: 'google',
    hosts: [],
    fieldNames: ['refresh_token', 'client_id'],
    state: 'active',
    createdAt: 1_757_635_200,
    ownerId: MEMBER_A,
    grantCount: 1,
  },
  createdBy: { handle: '@hoots', cause: 'sign-in', at: '12 Sep' },
  grants: [{ grantId: 'hoots', createdAt: 3 }],
  spendCap: 'none',
  ledger: [
    { at: '09:12', actor: '@hoots', action: 'send mail', status: '200', bytes: '0.4 kB' },
    { at: '08:58', actor: '', action: 'credential stored by @hoots (sign-in)' },
  ],
};

/**
 * A key whose label says nothing about its company and whose vault reports no
 * hosts: the shape that proves the row reads the vault's `service` rather
 * than guessing from a label or an address.
 */
export const GITHUB_CONNECTION: ConnectionDetailView = {
  connection: {
    ref: 'cred_github',
    name: 'Work key',
    service: 'github',
    hosts: [],
    fieldNames: ['token'],
    state: 'active',
    createdAt: 1_757_548_800,
    ownerId: MEMBER_A,
    grantCount: 1,
  },
  createdBy: { handle: '@hoots', cause: 'sign-up', at: '11 Sep' },
  grants: [{ grantId: 'hoots', createdAt: 4 }],
  spendCap: 'none',
  ledger: [{ at: '10:04', actor: '@hoots', action: 'open pull request', status: '201' }],
};

const MOCK_VIEWERS: readonly MockViewer[] = [
  {
    id: MEMBER_A,
    name: 'dani',
    connections: [VERCEL_CONNECTION, GOOGLE_CONNECTION, GITHUB_CONNECTION],
  },
  { id: MEMBER_B, name: 'terra', connections: [] },
];

export const MOCK_HELPERS: readonly WorkbenchHelper[] = [
  { id: 'helper-squire-box', name: 'squire-box', online: true },
  { id: 'helper-macbook', name: "Dani's MacBook", online: true },
  { id: 'helper-office-mini', name: 'office-mini', online: false },
];

export const INSTALL_STEP_LABELS = [
  (helperName: string) => `helper ${helperName} reached`,
  () => 'trusty-squire 1.4.2 installed',
  (workspaceName: string) => `paired to workspace ${workspaceName}`,
  () => 'waiting for sign-in',
  () => 'connections sync',
] as const;

/** The CLI command each install step runs, exactly as the helper reports it. */
export const INSTALL_STEP_COMMANDS = [
  (helperName: string) => `ssh ${helperName} squire status`,
  () => 'npm install -g trusty-squire@1.4.2',
  () => 'squire pair --workspace',
  () => 'squire auth login',
  () => 'squire vault sync',
] as const;

/** Live command output, captured while the step runs. */
export const INSTALL_STEP_OUTPUTS = [
  (helperName: string) => `ok · agent online · uptime 4d`,
  () => 'added 1 package in 2.1s',
  () => 'pairing token accepted',
  () => 'waiting for the browser sign-in…',
  () => 'synced 2 connections · 0 conflicts',
] as const;

/**
 * The mock install script: one step is revealed per poll, exactly the way the
 * helper's status reports arrive. `failAtStep` injects a failed step with a
 * helper reason, both for the failure UI and its render tests.
 */
export class MockWorkbenchSource implements WorkbenchSource {
  private readonly installs = new Map<string, MockInstall>();
  private failedConnectors = new Set<string>();
  private signInMethod: 'streamed' | 'oauth' | undefined;
  private apps: WorkbenchApp[] = [];
  /** Every connectApp call, so a test can read what the screen asked for. */
  readonly appRequests: { app: string; helperId: string; reconnect?: boolean }[] = [];

  async readWorkbench(input: {
    workspaceId: string;
    viewerId: string;
    refreshVault?: boolean;
  }): Promise<WorkbenchView> {
    const viewer = this.viewer(input.viewerId);
    const connected = this.installs.size > 0 || this.failedConnectors.size > 0;
    return {
      helpers: MOCK_HELPERS,
      connectors: [
        {
          id: 'trusty-squire',
          name: 'Trusty Squire',
          description: CONNECTOR_DESCRIPTIONS['trusty-squire'],
          available: true,
          ...(connected
            ? {
                status: this.failedConnectors.has('trusty-squire')
                  ? ('error' as const)
                  : ('connected' as const),
                helperName: 'squire-box',
                agentCount: 3,
                signedInAs: viewer ? `${viewer.name}@…` : undefined,
                ...(this.failedConnectors.has('trusty-squire')
                  ? {
                      errorMessage:
                        'another Trusty Squire session is already using the browser — close it first',
                    }
                  : {}),
              }
            : {}),
        },
        {
          id: 'wallet',
          name: 'Coinbase Wallet',
          description: CONNECTOR_DESCRIPTIONS['wallet'],
          available: true,
          status: 'disconnected',
        },
        {
          id: 'tailscale',
          name: 'Tailscale',
          description: CONNECTOR_DESCRIPTIONS['tailscale'],
          available: true,
          status: 'disconnected',
        },
        {
          id: 'google-gmail',
          name: 'Gmail',
          description: CONNECTOR_DESCRIPTIONS['google-gmail'],
          available: true,
          ...(this.failedConnectors.has('google-gmail')
            ? {
                status: 'error' as const,
                errorMessage:
                  'another Trusty Squire session is already using the browser — close it first',
              }
            : {}),
        },
        {
          id: 'google-calendar',
          name: 'Google Calendar',
          description: CONNECTOR_DESCRIPTIONS['google-calendar'],
          available: true,
        },
        {
          id: 'google-drive',
          name: 'Google Drive',
          description: CONNECTOR_DESCRIPTIONS['google-drive'],
          available: true,
        },
        {
          id: 'google-youtube',
          name: 'YouTube',
          description: CONNECTOR_DESCRIPTIONS['google-youtube'],
          available: true,
        },
      ],
      connections: viewer ? viewer.connections.map((detail) => detail.connection) : [],
      apps: viewer ? this.apps : [],
    };
  }

  /** The mock catalog rows, for the Google entry's connect-target resolution. */
  private mockConnectors(): readonly WorkbenchConnector[] {
    return GOOGLE_CONNECTOR_ORDER.map((id) => ({ id, name: '', description: '', available: true }));
  }

  async listHelpers(): Promise<readonly WorkbenchHelper[]> {
    return MOCK_HELPERS;
  }

  async pairConnector(input: {
    workspaceId: string;
    connectorId: string;
    helperId: string;
  }): Promise<{ connectorId: string }> {
    if (!MOCK_HELPERS.some((helper) => helper.id === input.helperId && helper.online)) {
      throw new Error('Helper is offline');
    }
    // The ONE Google entry resolves to the first not-yet-connected tool,
    // exactly like the real source (the mock's tools are never connected).
    const targetConnectorId =
      input.connectorId === GOOGLE_ENTRY_ID
        ? resolveGoogleConnectTarget(this.mockConnectors())
        : input.connectorId;
    const connectorId = `${targetConnectorId}:${input.helperId}-${this.installs.size + 1}`;
    this.installs.set(connectorId, {
      connectorId,
      helperId: input.helperId,
      revealed: 0,
      failAtStep: this.failedConnectors.has(input.connectorId) ? 2 : undefined,
    });
    return { connectorId };
  }

  async readInstallState(input: {
    workspaceId: string;
    connectorId: string;
  }): Promise<ConnectorInstallState | null> {
    const install = this.installs.get(input.connectorId);
    if (!install) return null;
    install.revealed = Math.min(install.revealed + 1, INSTALL_STEP_LABELS.length);
    const helper = MOCK_HELPERS.find((candidate) => candidate.id === install.helperId);
    const steps = INSTALL_STEP_LABELS.map((label, index) => {
      const helperLabel = label(helper?.name ?? 'the helper');
      const command = INSTALL_STEP_COMMANDS[index](helper?.name ?? 'the helper');
      const failShown = install.failAtStep !== undefined && install.revealed >= install.failAtStep;
      if (failShown && index === install.failAtStep) {
        return {
          label: helperLabel,
          status: 'failed' as const,
          reason: 'the helper could not reach the package registry',
          command,
          output: 'npm ERR! network request to registry.npmjs.org failed',
        };
      }
      if (failShown && index > (install.failAtStep as number)) {
        return { label: helperLabel, status: 'pending' as const };
      }
      return {
        label: helperLabel,
        status:
          index < install.revealed - 1
            ? ('done' as const)
            : index === install.revealed - 1
              ? ('active' as const)
              : ('pending' as const),
        command,
        ...(index <= install.revealed - 1
          ? { output: INSTALL_STEP_OUTPUTS[index](helper?.name ?? 'the helper') }
          : {}),
      };
    });
    const reachedSignIn =
      install.failAtStep === undefined && install.revealed >= INSTALL_STEP_LABELS.length - 1;
    const complete =
      install.failAtStep === undefined && install.revealed >= INSTALL_STEP_LABELS.length;
    return {
      connectorId: install.connectorId,
      helperName: helper?.name ?? 'the helper',
      steps,
      signIn: reachedSignIn
        ? {
            method: this.signInMethod ?? 'streamed',
            // The streamed noVNC page the helper reports; the app opens it verbatim.
            url: `https://login.example-squire.test/vnc.html#helper=${install.helperId}`,
          }
        : null,
      connected: complete,
    };
  }

  async readConnectionDetail(input: {
    workspaceId: string;
    ref: string;
    viewerId: string;
  }): Promise<ConnectionDetailView | null> {
    const viewer = this.viewer(input.viewerId);
    const detail = viewer?.connections.find((candidate) => candidate.connection.ref === input.ref);
    return detail ?? null;
  }

  async revokeAllGrants(input: { workspaceId: string; ref: string }): Promise<{ revoked: number }> {
    const detail = MOCK_VIEWERS.flatMap((candidate) => candidate.connections).find(
      (candidate) => candidate.connection.ref === input.ref,
    );
    if (!detail) return { revoked: 0 };
    const revoked = detail.grants.length;
    detail.grants = [];
    detail.connection = { ...detail.connection, grantCount: 0 };
    return { revoked };
  }

  async disconnectConnector(): Promise<void> {
    this.installs.clear();
  }

  async connectApp(input: {
    workspaceId: string;
    app: string;
    helperId: string;
    reconnect?: boolean;
  }): Promise<{ appId: string }> {
    this.appRequests.push({
      app: input.app,
      helperId: input.helperId,
      ...(input.reconnect ? { reconnect: true } : {}),
    });
    const key = input.app.toLowerCase().replace(/[^a-z0-9]/g, '');
    const existing = this.apps.find((app) => app.key === key);
    if (existing) {
      existing.status = 'connecting';
      return { appId: existing.id };
    }
    const id = `app-${key}`;
    this.apps.push({
      id,
      key,
      name: input.app,
      transport: 'squire-api',
      status: 'connecting',
      helperName: 'squire-box',
      helperId: input.helperId,
      useCount: 0,
    });
    return { appId: id };
  }

  async disconnectApp(input: { workspaceId: string; appId: string }): Promise<void> {
    this.apps = this.apps.filter((app) => app.id !== input.appId);
  }

  /** Test hook: seed the viewer's apps. */
  setApps(apps: readonly WorkbenchApp[]): void {
    this.apps = apps.map((app) => ({ ...app }));
  }

  /** Test hook: make the next pairing of this connector fail at a step. */
  failNextPair(connectorId: string): void {
    this.failedConnectors.add(connectorId);
  }

  /** Test hook: what sign-in method installs report (default streamed). */
  setSignInMethod(method: 'streamed' | 'oauth' | undefined): void {
    this.signInMethod = method;
  }

  private viewer(id: string): MockViewer | undefined {
    return MOCK_VIEWERS.find((candidate) => candidate.id === id);
  }
}

type MockInstall = {
  connectorId: string;
  helperId: string;
  revealed: number;
  failAtStep?: number;
};
