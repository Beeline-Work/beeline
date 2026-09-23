/**
 * Workbench: per-human connector provisioning and connection sovereignty.
 *
 * A connection belongs to whoever provisioned it; every read and write is
 * scoped to the VIEWER (`owner_identity_id` must equal the viewer). Receipts
 * arrive from the helper daemon (`postConnectionUsage`, batched one report
 * per agent turn) and are posted as DMs from a hidden CONNECTOR IDENTITY
 * (one per connector type, the way `@system` works) to the connection's
 * human. See `apps/server/src/workbench.ts` for the server authority and
 * `apps/server/src/system-line.ts` for the card grammar.
 *
 * The connector wire vocabulary (statuses, vault metadata, grants, ledger,
 * usage records) lives in `daemon-operations.ts` and is shared verbatim with
 * the helper PR.
 */
import type { ConnectorStatus, ConnectorStep } from './daemon-operations.js';
import type { WalletLedgerEntry } from './wallet.js';

export type { WalletLedgerEntry };

export type { ConnectorStatus, ConnectorStep };

/** Connector types known to the Workbench. */
export const CONNECTOR_KINDS = [
  'trusty-squire',
  'wallet',
  'tailscale',
  'google-gmail',
  'google-calendar',
  'google-drive',
  'google-youtube',
] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export function isConnectorKind(value: unknown): value is ConnectorKind {
  return typeof value === 'string' && (CONNECTOR_KINDS as readonly string[]).includes(value);
}

/**
 * Connector types the Workbench can actually pair today. The catalog rows for
 * the rest render as "soon" and refuse every operation.
 */
export const CONNECTABLE_CONNECTOR_KINDS: readonly ConnectorKind[] = [
  'trusty-squire',
  'tailscale',
  'google-gmail',
  'google-calendar',
  'google-drive',
  'google-youtube',
];

/**
 * The four Google Workspace tool kinds share one OAuth grant on a helper.
 * Pairing and status remain independent per product.
 */
export const GOOGLE_CONNECTOR_KINDS: readonly ConnectorKind[] = [
  'google-gmail',
  'google-calendar',
  'google-drive',
  'google-youtube',
];

/** Scope authority for the four independent Google product installs. */
export const GOOGLE_TOOL_SCOPES = {
  'google-gmail': [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
  ],
  'google-calendar': [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
  ],
  'google-drive': ['https://www.googleapis.com/auth/drive.readonly'],
  'google-youtube': [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
  ],
} as const;

export function isGoogleToolConnectorKind(value: ConnectorKind): boolean {
  return (GOOGLE_CONNECTOR_KINDS as readonly string[]).includes(value);
}

export type WorkbenchConnectorView = {
  readonly connectorId: string;
  readonly connectorType: ConnectorKind;
  /** The helper's last reported connector state. */
  readonly status: ConnectorStatus;
  readonly helperAgentId: string;
  readonly connectedAt?: number;
  readonly createdAt: number;
};

/**
 * The brand domain a connection's icon is fetched from, derived SERVER-SIDE
 * from the credential's first allowed host, exactly the way Trusty Squire's
 * vault does it (`faviconDomain()` in `apps/api/src/routes/vault.ts`): reduce
 * to the registrable domain, so `api.resend.com` reads `resend.com` and
 * `app.posthog.com` reads `posthog.com`. An API subdomain usually serves no
 * icon of its own.
 *
 * `null` when the credential reports no host (a session credential has none);
 * the mark then draws its lettermark. This is presentation metadata, not an
 * allowlist — nothing reads it to decide what a key may reach.
 */
export function faviconDomain(allowedHosts: readonly string[]): string | null {
  const host = allowedHosts[0];
  if (!host) return null;
  // A literal address names no brand, and the last-two-labels reduction would
  // turn `127.0.0.1` into the nonsense `0.1`. Beeline's vault can hold a
  // literal (a self-hosted service); Squire's reduction assumes a hostname.
  if (host.includes(':') || /^[\d.]+$/.test(host)) return null;
  const parts = host.split('.').filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

export type WorkbenchConnectionView = {
  readonly connectionId: string;
  readonly connectorId: string;
  readonly reference: string;
  readonly service: string | null;
  readonly label: string;
  readonly allowedHosts: readonly string[];
  /** Vault field names only. Secret values never cross this boundary. */
  readonly fieldNames: readonly string[];
  /** The brand domain for the row's icon, or `null` to draw the lettermark. */
  readonly faviconDomain: string | null;
  readonly state: 'active' | 'error';
  readonly lastSyncedAt?: number;
  /** True when the cached metadata is older than the 5-minute TTL. */
  readonly stale?: boolean;
  readonly createdAt: number;
};

export type WorkbenchCatalogEntry = {
  readonly connectorType: ConnectorKind;
  readonly name: string;
  readonly available: boolean;
};

/** One machine the viewer connected that can serve as a connector helper. */
export type WorkbenchHelperView = {
  /** The machine id (or agent id for legacy pre-machine agents). */
  readonly id: string;
  readonly name: string;
  /** Live durable presence evidence (the same 90-second window readers use). */
  readonly online: boolean;
};

export type WorkbenchView = {
  readonly workspaceId: string;
  readonly catalog: readonly WorkbenchCatalogEntry[];
  /** The VIEWER's connectors. Another member's connectors are never visible. */
  readonly connectors: readonly WorkbenchConnectorView[];
  /** The VIEWER's connections. Another member's connections are never visible. */
  readonly connections: readonly WorkbenchConnectionView[];
  /** The viewer's own connected machines — the Workbench's helper candidates. */
  readonly helpers: readonly WorkbenchHelperView[];
  /** Present when the VIEWER has created their wallet (no helper involved).
   *  `delegationActive` mirrors the wallet's delegated-signing grant — the
   *  row reads "agents can spend" only while it stands. */
  readonly wallet?: {
    readonly createdAt: number;
    readonly delegationActive: boolean;
    readonly delegationExpiresAt: number | null;
  };
};

export type ReadWorkbenchInput = { readonly workspaceId: string };
export type PairConnectorInput = {
  readonly workspaceId: string;
  readonly connectorType: ConnectorKind;
  /** A machine id (preferred) or an agent id (back-compat for clients that still send one). */
  readonly helperAgentId: string;
};
export type PairConnectorResult = {
  readonly connectorId: string;
  readonly status: ConnectorStatus;
};
export type UnpairConnectorInput = {
  readonly workspaceId: string;
  readonly connectorId: string;
};
export type ConnectionLedgerEntryView = {
  readonly id: string;
  readonly agentName?: string;
  readonly operation: string;
  readonly statusCode?: number;
  readonly bytes?: number;
  readonly grant?: string;
  readonly createdAt: number;
};
export type ReadConnectionDetailInput = {
  readonly workspaceId: string;
  readonly connectionId: string;
};
export type ConnectionDetailView = {
  readonly connection: WorkbenchConnectionView;
  readonly grants: readonly ConnectionGrantView[];
  readonly ledger: readonly ConnectionLedgerEntryView[];
};
export type ConnectionGrantView = {
  readonly grantId: string;
  readonly credentialRef: string;
  readonly createdAt: number;
  readonly revokedAt?: number;
  readonly rateLimitPerHour?: number;
  readonly spendCapUsd?: number;
};
export type RevokeConnectionGrantsInput = {
  readonly workspaceId: string;
  readonly connectionId: string;
};
export type RevokeConnectionGrantsResult = {
  readonly revoked: number;
  readonly failed: number;
};

// --- Helper work queue (server → helper delivery) --------------------------------

export type {
  ConnectorAssignment,
  ConnectorAssignmentsResult,
  ConnectionGrant,
  ConnectionUsageRecord,
  PostConnectionUsageInput,
  VaultConnectionMeta,
} from './daemon-operations.js';
