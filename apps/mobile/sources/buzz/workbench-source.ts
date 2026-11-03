import {projectWorkbenchDisplay,projectWorkbenchConnection} from '@beeline/api-contract/workbench';
import type {
  ConnectionDetailView,
  ConnectorInstallState,
  ConnectorInstallStep,
  WorkbenchApp,
  WorkbenchConnector,
  WorkbenchConnectorId,
  WorkbenchHelper,
  WorkbenchRowId,
  WorkbenchView,
} from './workbench';
import {
  CONNECTOR_DESCRIPTIONS,
  GOOGLE_ENTRY_ID,
  connectionSpendCap,
  ledgerBytes,
  ledgerStamp,
  resolveGoogleConnectTarget,
  WALLET_GRANT_ENDED_MESSAGE,
} from './workbench';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { GOOGLE_ACCOUNT_CONNECTOR_ID } from '@beeline/api-contract/workbench';
import type { WorkbenchAppSearchResult } from '@beeline/api-contract/workbench';
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
  searchApps(input: { query: string }): Promise<WorkbenchAppSearchResult>;
  beginLinkSignIn(): Promise<{ authorizationUrl: string }>;
  cancelLinkSignIn(state?: string): Promise<void>;
  disconnectLinkSignIn(): Promise<void>;
  readWorkbench(input: {
    workspaceId: string;
    viewerId: string;
    refreshVault?: boolean;
  }): Promise<WorkbenchView>;
  readConnectApp(input: { workspaceId: string; viewerId: string }): Promise<{
    view?: WorkbenchView; suggestions?: WorkbenchAppSearchResult;
    workbenchError?: string; suggestionsError?: string;
  }>;
  listHelpers(input: { workspaceId: string }): Promise<readonly WorkbenchHelper[]>;
  /** Pair a machine's helper: returns the connector whose install is polled. */
  pairConnector(input: {
    workspaceId: string;
    connectorId: string;
    helperId: string;
  }): Promise<{ connectorId: string }>;
  cancelGoogleSignIn(input: { connectorId: string; state?: string }): Promise<boolean>;
  beginGoogleSignIn(input: { workspaceId: string;
    connectorType: 'google-gmail' | 'google-calendar' | 'google-drive' | 'google-youtube' }): Promise<{ authorizationUrl: string }>;
  readInstallState(input: {
    workspaceId: string;
    connectorId: string;
  }): Promise<ConnectorInstallState | null>;
  readConnectionDetail(input: {
    workspaceId: string;
    connectionId: string;
    viewerId: string;
  }): Promise<ConnectionDetailView | null>;
  revokeAllGrants(input: { workspaceId: string; connectionId: string }): Promise<{
    revoked: number;
    pending?: number;
  }>;
  disconnectConnector(input: { workspaceId: string; connectorId: string }): Promise<void>;
  /** The one front door: the server resolves the route; the helper's agent
   * completes any sign-in through Trusty Squire. */
  connectApp(input: {
    workspaceId: string;
    app: string;
    helperId: string;
    reconnect?: boolean;
    registryServerName?: string;
    registryVersion?: string;
    preferredRoute?: 'composio' | 'squire-api';
  }): Promise<{ appId: string; authorizationUrl?: string }>;
  beginAppSignIn(input: { appId: string }): Promise<{ authorizationUrl: string }>;
  completeAppSignIn(input: { sessionUri: string; appId: string }): Promise<{ appId: string }>;
  disconnectApp(input: { workspaceId: string; appId: string }): Promise<void>;
}

type WorkbenchDto = PhoneOperationMap['readWorkbench']['output'];
type ConnectorViewDto = WorkbenchDto['connectors'][number];
type ConnectionViewDto = WorkbenchDto['connections'][number];

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
  async readConnectApp(input: { workspaceId: string; viewerId: string }) {
    const result = await monolithPhoneOperation('readConnectApp', { workspaceId: input.workspaceId });
    return {
      ...(result.workbench ? { view: await this.readWorkbench(input, result.workbench) } : {}),
      ...(result.suggestions ? { suggestions: result.suggestions } : {}),
      ...(result.workbenchError ? { workbenchError: result.workbenchError } : {}),
      ...(result.suggestionsError ? { suggestionsError: result.suggestionsError } : {}),
    };
  }
  async searchApps(input: { query: string }): Promise<WorkbenchAppSearchResult> {
    return monolithPhoneOperation('searchWorkbenchApps', input);
  }
  beginLinkSignIn(): Promise<{ authorizationUrl: string }> {
    return monolithPhoneOperation('beginLinkSignIn', {});
  }

  async cancelLinkSignIn(state?: string): Promise<void> {
    await monolithPhoneOperation('cancelLinkSignIn', { state });
  }

  async disconnectLinkSignIn(): Promise<void> {
    await monolithPhoneOperation('disconnectLinkSignIn', {});
  }

  async readWorkbench(input: {
    workspaceId: string;
    viewerId: string;
    refreshVault?: boolean;
  }, supplied?: WorkbenchDto): Promise<WorkbenchView> {
    const dto = supplied ?? await monolithPhoneOperation('readWorkbench', {
      workspaceId: input.workspaceId,
      ...(input.refreshVault ? { refreshVault: true } : {}),
    });
    return projectWorkbenchDisplay(dto,input.viewerId);
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

  async cancelGoogleSignIn(input: { connectorId: string; state?: string }): Promise<boolean> {
    return (await monolithPhoneOperation('cancelGoogleSignIn', input)).cancelled;
  }

  async beginGoogleSignIn(input: { workspaceId: string;
    connectorType: 'google-gmail' | 'google-calendar' | 'google-drive' | 'google-youtube' }): Promise<{ authorizationUrl: string }> {
    return monolithPhoneOperation('beginGoogleSignIn', { connectorType: input.connectorType });
  }

  async readInstallState(input: {
    workspaceId: string;
    connectorId: string;
  }): Promise<ConnectorInstallState | null> {
    if (input.connectorId === GOOGLE_ACCOUNT_CONNECTOR_ID) {
      const state = await monolithPhoneOperation('readGoogleSignIn', {});
      // A previously granted tool does not complete a newly pending top-up.
      return { connectorId: input.connectorId, steps: [],
        connected: state.connected && !state.authorizationUrl,
        signIn: state.authorizationUrl ? { method: 'oauth', url: state.authorizationUrl } : null };
    }
    const row = await monolithPhoneOperation('readConnectorInstall', input);
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
    connectionId: string;
    viewerId: string;
  }): Promise<ConnectionDetailView | null> {
    const detail = await monolithPhoneOperation('readConnectionDetail', {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
    });
    return {
      connection: projectWorkbenchConnection(detail.connection, input.viewerId),
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
    connectionId: string;
  }): Promise<{ revoked: number; pending?: number }> {
    const result = await monolithPhoneOperation('revokeConnectionGrants', {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
    });
    return {
      revoked: result.revoked,
      ...(result.pending ? { pending: result.pending } : {}),
    };
  }

  async disconnectConnector(input: { workspaceId: string; connectorId: string }): Promise<void> {
    if (input.connectorId.startsWith('squire:')) {
      await monolithPhoneOperation('unpairConnector', input);
      return;
    }
    const dto = await monolithPhoneOperation('readWorkbench', { workspaceId: input.workspaceId });
    if (input.connectorId === GOOGLE_ACCOUNT_CONNECTOR_ID ||
        (input.connectorId.startsWith('google-') &&
          dto.googleAccount?.connectedTypes.includes(input.connectorId))) {
      await monolithPhoneOperation('disconnectGoogleSignIn', {});
      return;
    }
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

  async connectApp(input: {
    workspaceId: string;
    app: string;
    helperId: string;
    reconnect?: boolean;
    registryServerName?: string;
    registryVersion?: string;
    preferredRoute?: 'composio' | 'squire-api';
  }): Promise<{ appId: string; authorizationUrl?: string }> {
    const result = await monolithPhoneOperation('connectWorkbenchApp', {
      workspaceId: input.workspaceId,
      app: input.app,
      helperAgentId: input.helperId,
      ...(input.reconnect ? { reconnect: true } : {}),
      ...(input.registryServerName ? { registryServerName: input.registryServerName } : {}),
      ...(input.registryVersion ? { registryVersion: input.registryVersion } : {}),
      ...(input.preferredRoute ? { preferredRoute: input.preferredRoute } : {}),
    });
    return { appId: result.appId, ...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}) };
  }

  async beginAppSignIn(input: { appId: string }): Promise<{ authorizationUrl: string }> {
    return monolithPhoneOperation('beginAppSignIn', input);
  }

  async completeAppSignIn(input: { sessionUri: string; appId: string }): Promise<{ appId: string }> {
    return monolithPhoneOperation('completeAppSignIn', input);
  }

  async disconnectApp(input: { workspaceId: string; appId: string }): Promise<void> {
    await monolithPhoneOperation('disconnectWorkbenchApp', input);
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
