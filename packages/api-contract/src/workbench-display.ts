import type {WorkbenchView as WorkbenchDto} from './workbench.js';
type ConnectorViewDto=WorkbenchDto['connectors'][number];
type ConnectionViewDto=WorkbenchDto['connections'][number];

/** Canonical display blocks for the owner stream; legacy adapters share this
 * projection so the phone never reconstructs a negotiated Workbench. */
export type WorkbenchDisplayConnectorId =
  | 'trusty-squire'
  | 'wallet'
  | 'tailscale'
  | 'google-gmail'
  | 'google-calendar'
  | 'google-drive'
  | 'google-youtube';
/**
 * A catalog row is keyed by its fixed connector id; a dynamically connected
 * Registry MCP row is keyed by its own connector uuid instead.
 */
export type WorkbenchDisplayRowId = WorkbenchDisplayConnectorId | (string & {});


export type WorkbenchDisplayConnectorStatus = 'disconnected' | 'installing' | 'connected' | 'error';

export type WorkbenchDisplayConnector = {
  id: WorkbenchDisplayRowId;
  name: string;
  description: string;
  /** `soon` connectors are listed for the section's shape and never act. */
  available: boolean;
  status?: WorkbenchDisplayConnectorStatus;
  /** Disconnecting this tool revokes the shared direct Google account grant. */
  sharedGoogleAccount?: boolean;
  /** The helper's exact failure text. Recovery reuses Connect. */
  errorMessage?: string;
  /** When connected: helper name, agent count and sign-in email. */
  helperName?: string;
  agentCount?: number;
  signedInAs?: string;
};

export type WorkbenchDisplayConnection = {
  connectionId: string;
  ref: string;
  name: string;
  /**
   * The service this key is FOR, exactly as the vault reports it (`vercel`,
   * `github`, `google`) — `workspace_connections.service`, carried by the
   * read DTO's own `service` field. Absent when the vault reports none.
   *
   * It was called `kind` and documented as the vault kind (`session`,
   * `token`), which is not what `workbench-source.ts` has ever filled it
   * with. A reader who believed the old name had to guess the company from
   * somewhere else; this is the authority, so it is named for what it is.
   */
  service?: string;
  hosts: readonly string[];
  /** Names of fields in the vault entry. Values never leave the vault. */
  fieldNames?: readonly string[];
  /**
   * The brand domain for the row's icon, derived by the SERVER from the
   * credential's first allowed host (`faviconDomain` in
   * `@beeline/api-contract/workbench`) — `api.resend.com` reads
   * `resend.com`. Absent when the credential reports no host; the mark then
   * draws its lettermark.
   */
  faviconDomain?: string;
  state: 'active' | 'error';
  /** The server is refreshing cached vault metadata older than its TTL. */
  stale?: boolean;
  lastSyncedAt?: number;
  createdAt?: number;
  /** Which human provisioned the connection (sovereignty owner). */
  ownerId: string;
  /** Grant count for the connection list's quiet line. */
  grantCount?: number;
};

/**
 * One connected app — ONE row whatever serves it (`connect_app`, the one
 * front door). The server chose the route; the row states which, in words.
 */
export type WorkbenchDisplayApp = {
  id: string;
  key: string;
  name: string;
  /** Brand domain for the row's mark; absent draws the lettermark. */
  domain?: string;
  description?: string;
  logo?: string;
  transport: 'registry-mcp' | 'composio' | 'squire-api' | 'squire-browser';
  status: 'connecting' | 'connected' | 'error';
  errorMessage?: string;
  helperName?: string;
  /** The machine that serves it, for a Reconnect. */
  helperId?: string;
  /** The vault key a Squire route holds — folded into this row, not Keys. */
  connectionReference?: string;
  useCount: number;
  lastUsedAt?: number;
  createdAt?: number;
  /** Owner-visible account identity and last use attribution from the server. */
  accountLabel?: string;
  workspaceName?: string;
  lastUse?: { agentId: string; agentName: string; roomId: string; roomName: string; usedAt: number };
};

export type WorkbenchDisplayView = {
  aiClients?: readonly import('./workbench.js').AiClientConnection[];
  companies?: import('./workbench.js').WorkbenchCompanyIndex;
  linkAccount?: { connected: boolean; pending: boolean; ineligible: boolean };
  connectors: readonly WorkbenchDisplayConnector[];
  connections: readonly WorkbenchDisplayConnection[];
  /** The viewer's apps, one row each. */
  apps: readonly WorkbenchDisplayApp[];
  appCatalog?: readonly { appKey: string; description?: string; logo?: string }[];
  /** The viewer's own connected machines — the Workbench's helper candidates. */
  helpers: readonly WorkbenchDisplayHelper[];
};

export type WorkbenchDisplayHelper = {
  id: string;
  name: string;
  online: boolean;
  squire?: { status: 'connected' | 'error' | 'not-added'; errorMessage?: string; reportedAt: number };
};

/** The Wallet row's error line once an earlier grant to sign has ended. */
export const WALLET_GRANT_ENDED_MESSAGE = 'Permission to sign ended. Reconnect to let agents spend.';

/** The one-sentence user story under each catalog row before anything is
 *  paired (board revision 2, PR #1351). The Google tools share the entry's
 *  one covering sentence. */
export const CONNECTOR_DESCRIPTIONS: Record<WorkbenchDisplayConnectorId, string> = {
  'trusty-squire':
    'With Trusty Squire, just by linking your Google account, Beeline agents can sign up for software services for you without you having to be involved.',
  wallet:
    "With Coinbase's non-custodial wallet API, you can transfer and receive crypto assets across 16 different EVM chains as well as Solana—with free transaction fees on Base.",
  tailscale:
    'Allows the machines in your Beeline network to connect to each other to form a tailnet.',
  'google-gmail': 'Covers Gmail, Google Calendar, YouTube, and other Google services.',
  'google-calendar': 'Covers Gmail, Google Calendar, YouTube, and other Google services.',
  'google-drive': 'Covers Gmail, Google Calendar, YouTube, and other Google services.',
  'google-youtube': 'Covers Gmail, Google Calendar, YouTube, and other Google services.',
};


function toConnector(entry: {
  connectorType: string;
  name: string;
  available: boolean;
  row?: ConnectorViewDto;
}): WorkbenchDisplayConnector {
  const id: WorkbenchDisplayRowId = entry.connectorType;
  return {
    id,
    name: entry.name,
    description: CONNECTOR_DESCRIPTIONS[entry.connectorType as WorkbenchDisplayConnectorId] ?? '',
    available: entry.available,
    ...(entry.row
      ? {
          status: entry.row.status.status,
          helperName: entry.row.status.helperName,
          agentCount: entry.row.status.agentCount,
          signedInAs: entry.row.status.signedInAs,
          ...(entry.row.status.errorMessage ? { errorMessage: entry.row.status.errorMessage } : {}),
        }
      : {}),
  };
}

export function projectWorkbenchConnection(
  dto: ConnectionViewDto,
  viewerId: string,
): WorkbenchDisplayView['connections'][number] {
  return {
    connectionId: dto.connectionId,
    ref: dto.reference,
    name: dto.label,
    // The vault's own service, carried through as itself. A server that
    // reports none leaves the field absent rather than inventing a `vault`
    // placeholder, so the screens can tell "no service reported" from one.
    ...(dto.service ? { service: dto.service } : {}),
    hosts: dto.allowedHosts,
    fieldNames: dto.fieldNames,
    ...(dto.faviconDomain ? { faviconDomain: dto.faviconDomain } : {}),
    state: dto.state,
    ...(dto.stale ? { stale: true } : {}),
    ...(dto.lastSyncedAt !== undefined ? { lastSyncedAt: dto.lastSyncedAt } : {}),
    createdAt: dto.createdAt,
    ownerId: viewerId,
  };
}


export function projectWorkbenchDisplay(dto:WorkbenchDto,viewerId:string):WorkbenchDisplayView {
return {
      companies: dto.companies,
      aiClients: dto.aiClients,
      ...(dto.linkAccount ? { linkAccount: dto.linkAccount } : {}),
      helpers: dto.helpers.map((helper): WorkbenchDisplayHelper => ({
        id: helper.id,
        name: helper.name,
        online: helper.online,
        ...(helper.squire ? { squire: helper.squire } : {}),
      })),
      connectors: [
        ...dto.catalog.map((entry) => {
          if (entry.connectorType === 'trusty-squire') {
            const reports = dto.helpers.filter((helper) => helper.squire);
            const connected = reports.find((helper) => helper.squire?.status === 'connected');
            const failed = reports.find((helper) => helper.squire?.status === 'error');
            const helper = connected ?? failed;
            return { id: 'trusty-squire' as const, name: entry.name,
              description: CONNECTOR_DESCRIPTIONS['trusty-squire'], available: entry.available,
              status: connected ? 'connected' as const : failed ? 'error' as const : 'disconnected' as const,
              ...(helper ? { helperName: helper.name } : {}),
              ...(failed && !connected ? { errorMessage: failed.squire?.errorMessage } : {}) };
          }
          // Wallet creation is a direct human operation, not a helper
          // connector install. The server catalog's helper availability does
          // not govern whether this row can act. The row is connected only
          // once agents hold an active grant to sign; a wallet whose earlier
          // grant ended asks to reconnect.
          if (entry.connectorType === 'wallet') {
            const ended = dto.wallet && !dto.wallet.delegationActive
              && dto.wallet.delegationExpiresAt !== null;
            return {
              id: 'wallet' as const,
              name: entry.name,
              description: CONNECTOR_DESCRIPTIONS.wallet,
              available: true,
              status: dto.wallet?.delegationActive ? ('connected' as const)
                : ended ? ('error' as const) : ('disconnected' as const),
              ...(ended ? { errorMessage: WALLET_GRANT_ENDED_MESSAGE } : {}),
            };
          }
          if (entry.connectorType.startsWith('google-') && dto.googleAccount) {
            const row = dto.connectors.find(candidate => candidate.connectorType === entry.connectorType);
            if (dto.googleAccount.connected || dto.googleAccount.pending) {
              return { ...toConnector({ connectorType: entry.connectorType, name: entry.name,
                available: true, row }), available: true,
                sharedGoogleAccount: dto.googleAccount.connectedTypes.includes(entry.connectorType),
                signedInAs: dto.googleAccount.accountEmail,
                status: dto.googleAccount.connectedTypes.includes(entry.connectorType)
                  || row?.status.status === 'connected'
                  ? 'connected' as const : dto.googleAccount.pending ? 'installing' as const
                    : 'disconnected' as const,
                errorMessage: undefined };
            }
            return { ...toConnector({ connectorType: entry.connectorType, name: entry.name,
              available: true, row }), available: true,
              status: row?.status.status === 'connected' ? 'connected' as const : 'disconnected' as const,
              errorMessage: undefined };
          }
          return toConnector({
            connectorType: entry.connectorType,
            name: entry.name,
            available: entry.available,
            row: dto.connectors.find(
              (candidate) => candidate.connectorType === entry.connectorType &&
                candidate.status.status === 'connected',
            ) ?? dto.connectors.find(
              (candidate) => candidate.connectorType === entry.connectorType,
            ),
          });
        }),
      ],
      // A Registry server is an app now: its row is the app's, never a
      // second dynamic tool row.
      apps: (dto.apps ?? []).map((app): WorkbenchDisplayApp => ({
        id: app.appId,
        key: app.appKey,
        name: app.name,
        ...(app.domain ? { domain: app.domain } : {}),
        ...(app.description ? { description: app.description } : {}),
        ...(app.logo ? { logo: app.logo } : {}),
        transport: app.transport,
        status: app.status,
        ...(app.errorMessage ? { errorMessage: app.errorMessage } : {}),
        ...(app.helperName ? { helperName: app.helperName } : {}),
        ...(app.helperId ? { helperId: app.helperId } : {}),
        ...(app.connectionReference ? { connectionReference: app.connectionReference } : {}),
        useCount: app.useCount,
        ...(app.lastUsedAt !== undefined ? { lastUsedAt: app.lastUsedAt } : {}),
        ...(app.createdAt !== undefined ? { createdAt: app.createdAt } : {}),
        ...(app.accountLabel ? { accountLabel: app.accountLabel } : {}),
        ...(app.workspaceName ? { workspaceName: app.workspaceName } : {}),
        ...(app.lastUse ? { lastUse: { ...app.lastUse } } : {}),
      })),
      appCatalog: dto.appCatalog ?? [],
      connections: dto.connections.map((connection) => projectWorkbenchConnection(connection, viewerId)),
    };
}
