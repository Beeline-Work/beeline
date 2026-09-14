/**
 * Workbench view models — the shapes the Workbench screens render, named
 * after the report's PR 2 endpoint contracts (`GET /workspace/:id/workbench`,
 * `GET /workspace/:id/connections/:ref`). Until the server lands, the mock
 * source in `workbench-source.ts` fills them; the screens never read the mock
 * directly, so the swap is one module.
 *
 * Sovereignty is per HUMAN: a connection belongs to whoever provisioned it.
 * The server enforces this; `connectionsForViewer` is the client-side
 * projection the screens render from, so member B's Workbench never paints
 * member A's connections even if a rogue payload arrives.
 */

export type WorkbenchConnectorId = 'trusty-squire' | 'wallet' | 'tailscale';

export type WorkbenchConnectorStatus = 'disconnected' | 'installing' | 'connected' | 'error';

export type WorkbenchConnector = {
  id: WorkbenchConnectorId;
  name: string;
  description: string;
  /** `soon` connectors are listed for the section's shape and never act. */
  available: boolean;
  status?: WorkbenchConnectorStatus;
  /** When connected: helper name, agent count and sign-in email. */
  helperName?: string;
  agentCount?: number;
  signedInAs?: string;
};

export type WorkbenchConnection = {
  ref: string;
  name: string;
  /** Vault kind: `session`, `token`, … */
  kind: string;
  hosts: readonly string[];
  state: 'active' | 'error';
  /** Which human provisioned the connection (sovereignty owner). */
  ownerId: string;
  /** Grant count for the connection list's quiet line. */
  grantCount?: number;
};

export type WorkbenchView = {
  connectors: readonly WorkbenchConnector[];
  connections: readonly WorkbenchConnection[];
};

export type WorkbenchHelper = {
  id: string;
  name: string;
  platform: 'linux' | 'macos' | 'windows';
  agentCount: number;
  online: boolean;
};

export type ConnectorInstallStepStatus = 'done' | 'active' | 'pending' | 'failed';

export type ConnectorInstallStep = {
  label: string;
  status: ConnectorInstallStepStatus;
  /** The helper's own reason, shown in red under a failed step. */
  reason?: string;
};

export type ConnectorSignInMethod = 'streamed' | 'oauth';

export type ConnectorSignIn = {
  method: ConnectorSignInMethod;
  /** Exactly the URL the server relays — the app opens what it is told. */
  url: string;
};

export type ConnectorInstallState = {
  requestId: string;
  helperName: string;
  steps: readonly ConnectorInstallStep[];
  signIn: ConnectorSignIn | null;
  connected: boolean;
};

export type ConnectionGrant = {
  agent: string;
  kinds: readonly string[];
};

export type ConnectionLedgerRow = {
  at: string;
  actor: string;
  action: string;
  status?: string;
  bytes?: string;
};

export type ConnectionDetailView = {
  connection: WorkbenchConnection;
  createdBy: { handle: string; cause: string; at: string };
  grants: readonly ConnectionGrant[];
  spendCap: string;
  ledger: readonly ConnectionLedgerRow[];
};

const CONNECTOR_IDENTITY_PREFIX = 'connector:';

/**
 * The sovereignty projection: only connections the viewer provisioned. The
 * report's story 4 — member B's Workbench shows none of member A's rows.
 */
export function connectionsForViewer(
  view: WorkbenchView,
  viewerId: string,
): readonly WorkbenchConnection[] {
  return view.connections.filter((connection) => connection.ownerId === viewerId);
}

/** Trailing value word for a connector row. */
export function connectorRowValue(connector: WorkbenchConnector): string {
  if (!connector.available) return 'soon';
  switch (connector.status) {
    case 'connected':
      return 'connected';
    case 'installing':
      return 'installing';
    case 'error':
      return 'error';
    default:
      return 'connect';
  }
}

/** The quiet line under a connected connector: what it runs on. */
export function connectorDescription(connector: WorkbenchConnector): string {
  if (connector.status !== 'connected') return connector.description;
  return [
    `on ${connector.helperName ?? 'a helper'}`,
    connector.agentCount !== undefined ? `${connector.agentCount} agents` : undefined,
    connector.signedInAs ? `signed in as ${connector.signedInAs}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The hidden connector identity that sends receipt DMs, e.g. `@trusty-squire`. */
export function connectorIdentityHandle(connectorId: WorkbenchConnectorId): string {
  return `@${connectorId}`;
}

/** The deterministic identity marker a connector DM's author carries. */
export function connectorIdentityId(connectorId: WorkbenchConnectorId): string {
  return `${CONNECTOR_IDENTITY_PREFIX}${connectorId}`;
}

export function isConnectorIdentityId(identityId: string | undefined | null): boolean {
  return Boolean(identityId?.startsWith(CONNECTOR_IDENTITY_PREFIX));
}

/** `api.vercel.com` joined, or `—` when a session kind has no host list. */
export function connectionHostsLine(connection: WorkbenchConnection): string {
  return connection.hosts.length ? connection.hosts.join(', ') : '—';
}

/** `@hoots · sign-up · 13 Sep` */
export function connectionCreatedByLine(detail: ConnectionDetailView): string {
  return `${detail.createdBy.handle} · ${detail.createdBy.cause} · ${detail.createdBy.at}`;
}

/** `hoots (deploy, list) · terra (list)` — the agent and its grant kinds. */
export function connectionGrantsLine(detail: ConnectionDetailView): string {
  if (!detail.grants.length) return 'none';
  return detail.grants
    .map((grant) => `${grant.agent} (${grant.kinds.join(', ')})`)
    .join(' · ');
}
