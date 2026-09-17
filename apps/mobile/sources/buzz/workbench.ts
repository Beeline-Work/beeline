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

export type WorkbenchConnectorId =
  | 'trusty-squire'
  | 'wallet'
  | 'tailscale'
  | 'google-gmail'
  | 'google-calendar'
  | 'google-drive'
  | 'google-youtube';

/** True for the Google Workspace tool connectors — the four tools behind the
 * ONE Google connect entry (`googleEntryConnector`). */
export function isGoogleToolConnectorId(id: string): id is
  | 'google-gmail'
  | 'google-calendar'
  | 'google-drive'
  | 'google-youtube' {
  return id.startsWith('google-');
}

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
  /** The viewer's own connected machines — the Workbench's helper candidates. */
  helpers: readonly WorkbenchHelper[];
};

export type WorkbenchHelper = {
  id: string;
  name: string;
  online: boolean;
};

/** The quiet line under each catalog row before anything is paired. */
export const CONNECTOR_DESCRIPTIONS: Record<WorkbenchConnectorId, string> = {
  'trusty-squire': 'vault, sign-ups, payments',
  wallet: 'your agents can spend',
  tailscale: 'private network for helpers',
  'google-gmail': 'one Google OAuth grant for your agents',
  'google-calendar': 'one Google OAuth grant for your agents',
  'google-drive': 'one Google OAuth grant for your agents',
  'google-youtube': 'one Google OAuth grant for your agents',
};

/**
 * The ONE Google connect entry: the four Google tool connectors fold into a
 * single logical "Google Workspace" row on the Workbench and connect
 * screens, so one connect flow covers every tool with one Google grant.
 * Tool identity is unchanged — the server keeps four connector kinds/rows,
 * installs and receipts stay per-tool; only consent and connect UX fold.
 */
export const GOOGLE_ENTRY_ID = 'google';

/** Canonical order of the tool entries the single Google entry folds. */
export const GOOGLE_CONNECTOR_ORDER: readonly (
  | 'google-gmail'
  | 'google-calendar'
  | 'google-drive'
  | 'google-youtube'
)[] = ['google-gmail', 'google-calendar', 'google-drive', 'google-youtube'];

type GoogleToolId = (typeof GOOGLE_CONNECTOR_ORDER)[number];

function googleEntryTools(
  connectors: readonly WorkbenchConnector[],
): readonly WorkbenchConnector[] {
  return GOOGLE_CONNECTOR_ORDER.map((id) =>
    connectors.find((connector) => connector.id === id),
  ).filter((tool): tool is WorkbenchConnector => tool !== undefined);
}

/** The single Google entry's state across its four tool connectors: fully
 * connected → `connected`; any install in flight → `installing`; any tool
 * error → `error`; SOME connected (a top-up is available) → `repair`;
 * none connected → `connect`. */
export type GoogleEntryState = 'connected' | 'installing' | 'error' | 'repair' | 'connect';

export function googleEntryState(
  connectors: readonly WorkbenchConnector[],
): GoogleEntryState {
  const tools = googleEntryTools(connectors);
  if (tools.length && tools.every((tool) => tool.status === 'connected')) return 'connected';
  if (tools.some((tool) => tool.status === 'installing')) return 'installing';
  if (tools.some((tool) => tool.status === 'error')) return 'error';
  if (tools.some((tool) => tool.status === 'connected')) return 'repair';
  return 'connect';
}

/** Fold the four google tool connectors into the ONE logical Google entry.
 * `undefined` when the catalog lists none of them. Connected helpers and
 * sign-in surface come from the first connected tool. */
export function googleEntryConnector(
  connectors: readonly WorkbenchConnector[],
): (Omit<WorkbenchConnector, 'id'> & { id: typeof GOOGLE_ENTRY_ID }) | undefined {
  const tools = googleEntryTools(connectors);
  if (!tools.length) return undefined;
  const state = googleEntryState(connectors);
  const connected = tools.find((tool) => tool.status === 'connected');
  return {
    id: GOOGLE_ENTRY_ID,
    name: 'Google Workspace',
    description: CONNECTOR_DESCRIPTIONS['google-gmail'],
    available: tools.some((tool) => tool.available),
    status:
      state === 'connected'
        ? 'connected'
        : state === 'installing'
          ? 'installing'
          : state === 'error'
            ? 'error'
            : 'disconnected',
    helperName: connected?.helperName,
    agentCount: connected?.agentCount,
    signedInAs: connected?.signedInAs,
  };
}

export type GoogleToolState = {
  id: GoogleToolId;
  name: string;
  status: WorkbenchConnectorStatus | undefined;
  /** Trailing word the expanded entry's tool line carries. */
  value: string;
};

/** Per-tool lines the expanded Google entry shows: what of the one grant is
 * already live, and what a connect/repair would top up. */
export function googleToolStates(
  connectors: readonly WorkbenchConnector[],
): readonly GoogleToolState[] {
  return googleEntryTools(connectors).map((tool) => ({
    id: tool.id as GoogleToolId,
    name: tool.name,
    status: tool.status,
    value:
      tool.status === 'connected'
        ? 'connected'
        : tool.status === 'installing'
          ? 'installing'
          : tool.status === 'error'
            ? 'error'
            : 'connect',
  }));
}

/** Trailing value word for the single Google entry row. */
export function googleEntryValue(state: GoogleEntryState): string {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'installing':
      return 'installing';
    case 'error':
      return 'error';
    case 'repair':
      return 'repair';
    default:
      return 'connect';
  }
}

/** The quiet line under the single Google entry row. A partially connected
 * set names how much of the one grant is live; otherwise the connected
 * helper/sign-in facts, or the catalog description before anything pairs. */
export function googleEntryDescription(
  connectors: readonly WorkbenchConnector[],
  state: GoogleEntryState,
): string {
  if (state === 'repair') {
    const tools = googleEntryTools(connectors);
    const connected = tools.filter((tool) => tool.status === 'connected').length;
    return `${connected} of ${tools.length} tools connected`;
  }
  const entry = googleEntryConnector(connectors);
  return entry ? connectorDescription(entry) : '';
}

/** The concrete Google tool type the single entry pairs first: the first
 * not-yet-connected tool in canonical order. When every tool is already
 * connected it re-arms the first — the server re-arms only the requested
 * type and keeps its connected siblings' live grants. */
export function resolveGoogleConnectTarget(
  connectors: readonly WorkbenchConnector[],
): GoogleToolId {
  for (const id of GOOGLE_CONNECTOR_ORDER) {
    const tool = connectors.find((connector) => connector.id === id);
    if (tool && tool.status !== 'connected') return id;
  }
  return GOOGLE_CONNECTOR_ORDER[0];
}

export type ConnectorInstallStepStatus = 'done' | 'active' | 'pending' | 'failed';

export type ConnectorInstallStep = {
  label: string;
  status: ConnectorInstallStepStatus;
  /** The helper's own reason, shown in red under a failed step. */
  reason?: string;
  /** The CLI command this step runs, when the helper reports one. */
  command?: string;
  /** The step's live output (CLI/tool logs), streamed while it runs. */
  output?: string;
};

export type ConnectorSignInMethod = 'streamed' | 'oauth';

export type ConnectorSignIn = {
  method: ConnectorSignInMethod;
  /** Exactly the URL the server relays — the app opens what it is told. */
  url: string;
};

export type ConnectorInstallState = {
  connectorId: string;
  helperName?: string;
  steps: readonly ConnectorInstallStep[];
  signIn: ConnectorSignIn | null;
  connected: boolean;
};

export type ConnectionGrant = {
  grantId: string;
  createdAt?: number;
  spendCapUsd?: number;
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
  /** Present only when the vault reports the provisioning event. */
  createdBy?: { handle: string; cause: string; at: string };
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
  // The server already returns only the viewer's own rows; this filter is a
  // second line of defence, not the authority. An EMPTY viewer id therefore
  // means "the caller did not carry one", not "this person owns nothing", and
  // must not blank a list the server already scoped. The Workbench screen is
  // reached from personal settings with no route params, which is exactly
  // that case.
  if (!viewerId) return view.connections;
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
export function connectorDescription(
  connector: Omit<WorkbenchConnector, 'id'> & { id: string },
): string {
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

/** `@hoots · sign-up · 13 Sep`, or '' when the vault reports no such fact. */
export function connectionCreatedByLine(detail: ConnectionDetailView): string {
  if (!detail.createdBy) return '';
  return `${detail.createdBy.handle} · ${detail.createdBy.cause} · ${detail.createdBy.at}`;
}

/** `2 live grants` — the server's grants carry no agent attribution. */
export function connectionGrantsLine(detail: ConnectionDetailView): string {
  if (!detail.grants.length) return 'none';
  return `${detail.grants.length} live grant${detail.grants.length === 1 ? '' : 's'}`;
}

/** `none`, or the tightest per-grant cap the vault reports. */
export function connectionSpendCap(grants: readonly ConnectionGrant[]): string {
  const caps = grants
    .map((grant) => grant.spendCapUsd)
    .filter((cap): cap is number => typeof cap === 'number');
  if (!caps.length) return 'none';
  return `$${Math.min(...caps)} cap`;
}

/** `14:26` when the entry is from today, otherwise `13 Sep`. */
export function ledgerStamp(createdAt: number, now: number = Date.now()): string {
  const date = new Date(createdAt < 1e12 ? createdAt * 1000 : createdAt);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return `${date.getDate()} ${date.toLocaleString('en', { month: 'short' })}`;
}

/** `1.2 kB` for a ledger row's bytes column. */
export function ledgerBytes(bytes: number): string | undefined {
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} kB`;
}
