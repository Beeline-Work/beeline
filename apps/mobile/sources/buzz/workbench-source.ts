import type {
  ConnectionDetailView,
  ConnectorInstallState,
  ConnectorInstallStep,
  WorkbenchConnector,
  WorkbenchConnectorId,
  WorkbenchHelper,
  WorkbenchView,
} from './workbench';
import {
  CONNECTOR_DESCRIPTIONS,
  GOOGLE_ENTRY_ID,
  connectionSpendCap,
  ledgerBytes,
  ledgerStamp,
  resolveGoogleConnectTarget,
} from './workbench';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/**
 * The Workbench data source. The DEFAULT is the real monolith source: every
 * method resolves through the same authenticated phone operations the rest
 * of the app uses (`monolithPhoneOperation`), and the server scopes every
 * read to the session's viewer — a connection belongs to whoever provisioned
 * it, so `viewerId` is accepted for interface compatibility and the client
 * sovereignty projection (`connectionsForViewer`) still holds. Tests install
 * the mock (`workbench-source.mock.ts`) through `setWorkbenchSource()`; the
 * screens never read either implementation directly.
 */
export interface WorkbenchSource {
  readWorkbench(input: { workspaceId: string; viewerId: string }): Promise<WorkbenchView>;
  listHelpers(input: { workspaceId: string }): Promise<readonly WorkbenchHelper[]>;
  /** Pair a machine's helper: returns the connector whose install is polled. */
  pairConnector(input: {
    workspaceId: string;
    connectorId: string;
    helperId: string;
  }): Promise<{ connectorId: string }>;
  readInstallState(input: {
    workspaceId: string;
    connectorId: string;
  }): Promise<ConnectorInstallState | null>;
  readConnectionDetail(input: {
    workspaceId: string;
    ref: string;
    viewerId: string;
  }): Promise<ConnectionDetailView | null>;
  revokeAllGrants(input: { workspaceId: string; ref: string }): Promise<{
    revoked: number;
    pending?: number;
  }>;
  disconnectConnector(input: { workspaceId: string; connectorId: string }): Promise<void>;
}

type WorkbenchDto = PhoneOperationMap['readWorkbench']['output'];
type ConnectorViewDto = WorkbenchDto['connectors'][number];
type ConnectionViewDto = WorkbenchDto['connections'][number];

function toConnector(entry: {
  connectorType: string;
  name: string;
  available: boolean;
  approvedTools?: readonly string[];
  row?: ConnectorViewDto;
}): WorkbenchConnector {
  const id = entry.connectorType as WorkbenchConnectorId;
  const approvedTools = entry.row?.approvedTools ?? entry.approvedTools;
  return {
    id,
    name: entry.name,
    description: approvedTools?.length
      ? `${CONNECTOR_DESCRIPTIONS[id] ?? ''} Approved tools: ${approvedTools.join(', ')}.`
      : CONNECTOR_DESCRIPTIONS[id] ?? '',
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

function toConnection(
  dto: ConnectionViewDto,
  viewerId: string,
): WorkbenchView['connections'][number] {
  return {
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

function toSteps(
  steps: readonly {
    label: string;
    status: string;
    reason?: string;
    command?: string;
    output?: string;
  }[],
): readonly ConnectorInstallStep[] {
  return steps.map((step) => ({
    label: step.label,
    status:
      step.status === 'done'
        ? ('done' as const)
        : step.status === 'running'
          ? ('active' as const)
          : step.status === 'failed'
            ? ('failed' as const)
            : ('pending' as const),
    ...(step.reason ? { reason: step.reason } : {}),
    ...(step.command ? { command: step.command } : {}),
    ...(step.output ? { output: step.output } : {}),
  }));
}

/**
 * The real source: one signed `readWorkbench` projection per poll, resolved
 * through the session's own viewer on the server.
 */
export class MonolithWorkbenchSource implements WorkbenchSource {
  async readWorkbench(input: { workspaceId: string; viewerId: string }): Promise<WorkbenchView> {
    const dto = await monolithPhoneOperation('readWorkbench', { workspaceId: input.workspaceId });
    return {
      helpers: dto.helpers.map((helper): WorkbenchHelper => ({
        id: helper.id,
        name: helper.name,
        online: helper.online,
      })),
      connectors: dto.catalog.map((entry) => {
        // Wallet creation is a direct human operation, not a helper
        // connector install. The server catalog's helper availability does
        // not govern whether this row can act.
        if (entry.connectorType === 'wallet') {
          return {
            id: 'wallet' as const,
            name: entry.name,
            description: CONNECTOR_DESCRIPTIONS.wallet,
            available: true,
            status: dto.wallet ? ('connected' as const) : ('disconnected' as const),
          };
        }
        return toConnector({
          connectorType: entry.connectorType,
          name: entry.name,
          available: entry.available,
          approvedTools: entry.approvedTools,
          row: dto.connectors.find((candidate) => candidate.connectorType === entry.connectorType),
        });
      }),
      connections: dto.connections.map((connection) => toConnection(connection, input.viewerId)),
    };
  }

  async listHelpers(input: { workspaceId: string }): Promise<readonly WorkbenchHelper[]> {
    const view = await this.readWorkbench({ ...input, viewerId: '' });
    return view.helpers;
  }

  async pairConnector(input: {
    workspaceId: string;
    connectorId: string;
    helperId: string;
  }): Promise<{ connectorId: string }> {
    // The ONE Google entry pairs the whole Google set: the logical `google`
    // id resolves here to the first not-yet-connected tool (canonical order);
    // the server provisions all four rows behind the one grant.
    let connectorType = input.connectorId;
    if (connectorType === GOOGLE_ENTRY_ID) {
      const view = await this.readWorkbench({ workspaceId: input.workspaceId, viewerId: '' });
      connectorType = resolveGoogleConnectTarget(view.connectors);
    }
    const result = await monolithPhoneOperation('pairConnector', {
      workspaceId: input.workspaceId,
      connectorType: connectorType as PhoneOperationMap['pairConnector']['input']['connectorType'],
      helperAgentId: input.helperId,
    });
    return { connectorId: result.connectorId };
  }

  async readInstallState(input: {
    workspaceId: string;
    connectorId: string;
  }): Promise<ConnectorInstallState | null> {
    const dto = await monolithPhoneOperation('readWorkbench', { workspaceId: input.workspaceId });
    // `pairConnector` returns the ROW's id, and the connect screen polls with
    // exactly that; the sign-in overlay still polls by connector type. Match
    // both — a row id alone must never read as "no install" (the silent stall).
    const row = dto.connectors.find(
      (candidate) =>
        candidate.connectorId === input.connectorId ||
        candidate.connectorType === input.connectorId,
    );
    if (!row) return null;
    return {
      connectorId: row.connectorId,
      ...(row.status.helperName ? { helperName: row.status.helperName } : {}),
      steps: toSteps(row.status.steps),
      signIn: row.status.signIn
        ? {
            method:
              row.status.signIn.method === 'oauth' ? ('oauth' as const) : ('streamed' as const),
            url: row.status.signIn.url,
            ...(row.status.signIn.browserLocation
              ? { browserLocation: row.status.signIn.browserLocation }
              : {}),
          }
        : null,
      connected: row.status.status === 'connected',
    };
  }

  async readConnectionDetail(input: {
    workspaceId: string;
    ref: string;
    viewerId: string;
  }): Promise<ConnectionDetailView | null> {
    const dto = await monolithPhoneOperation('readWorkbench', { workspaceId: input.workspaceId });
    const connection = dto.connections.find((candidate) => candidate.reference === input.ref);
    if (!connection) return null;
    const detail = await monolithPhoneOperation('readConnectionDetail', {
      workspaceId: input.workspaceId,
      connectionId: connection.connectionId,
    });
    return {
      connection: toConnection(detail.connection, input.viewerId),
      grants: detail.grants
        .filter((grant) => grant.revokedAt === undefined)
        .map((grant) => ({
          grantId: grant.grantId,
          createdAt: grant.createdAt,
          ...(grant.revokingAt !== undefined ? { revokingAt: grant.revokingAt } : {}),
          ...(grant.rateLimitPerHour !== undefined
            ? { rateLimitPerHour: grant.rateLimitPerHour }
            : {}),
          ...(grant.spendCapUsd !== undefined ? { spendCapUsd: grant.spendCapUsd } : {}),
        })),
      spendCap: connectionSpendCap(detail.grants),
      ledger: detail.ledger.map((entry) => ({
        at: ledgerStamp(entry.createdAt),
        actor: entry.agentName ?? '',
        action: entry.operation,
        ...(entry.statusCode !== undefined ? { status: String(entry.statusCode) } : {}),
        ...(entry.bytes !== undefined ? { bytes: ledgerBytes(entry.bytes) } : {}),
        ...(entry.grant ? { grant: entry.grant } : {}),
      })),
    };
  }

  async revokeAllGrants(input: {
    workspaceId: string;
    ref: string;
  }): Promise<{ revoked: number; pending?: number }> {
    const dto = await monolithPhoneOperation('readWorkbench', { workspaceId: input.workspaceId });
    const connection = dto.connections.find((candidate) => candidate.reference === input.ref);
    if (!connection) return { revoked: 0 };
    const result = await monolithPhoneOperation('revokeConnectionGrants', {
      workspaceId: input.workspaceId,
      connectionId: connection.connectionId,
    });
    return {
      revoked: result.revoked,
      ...(result.pending ? { pending: result.pending } : {}),
    };
  }

  async disconnectConnector(input: { workspaceId: string; connectorId: string }): Promise<void> {
    const dto = await monolithPhoneOperation('readWorkbench', { workspaceId: input.workspaceId });
    const row = dto.connectors.find(
      (candidate) =>
        candidate.connectorId === input.connectorId ||
        candidate.connectorType === input.connectorId,
    );
    if (!row) return;
    await monolithPhoneOperation('unpairConnector', {
      workspaceId: input.workspaceId,
      connectorId: row.connectorId,
    });
  }
}

let source: WorkbenchSource = new MonolithWorkbenchSource();

/** The one source the Workbench screens read. */
export function getWorkbenchSource(): WorkbenchSource {
  return source;
}

/** Test seam: install a source (or restore the real one with no argument). */
export function setWorkbenchSource(next?: WorkbenchSource): void {
  source = next ?? new MonolithWorkbenchSource();
}
