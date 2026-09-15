/**
 * The helper's connector work queue (Workbench PR 2).
 *
 * The server leaves one row per (connector, owner) in `pending_ops` whenever
 * a human pairs, revokes, or unpairs; `getConnectorAssignments` drains it on
 * read. This loop is what makes that queue REAL on the helper: every 10
 * seconds it asks for work, runs the Squire lifecycle (`connector-squire.ts`),
 * and reports each install step back through `postConnectorStatus` so the
 * phone paints progress live. A completed install reports through
 * `installConnector`, which flips the row to `connected` and persists the
 * sign-in surface and installed version; a failed step reports its error.
 *
 * One helper carries ONE Squire account (captain decision 2026-09-14), so
 * after an install or a `sync` assignment the vault list is reported once
 * through `postConnectorVault` and covers every connector this helper serves.
 * One assignment at a time per connector; failures are logged, never raised —
 * the next poll retries.
 */
import type {
  ConnectorAssignment,
  ConnectorStep,
  VaultConnectionMeta,
} from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  installSquire,
  readVault,
  revokeGrants,
  type InstallSquireOptions,
  type InstallSquireResult,
  type SquireMcpClient,
} from './connector-squire.js';
import { defaultSquireMcpClient } from './squire-mcp-client.js';

export const CONNECTOR_POLL_INTERVAL_MS = 10_000;

type ConnectorApi = Pick<DaemonApiClient, 'execute'>;

export type ConnectorAssignmentLoopOptions = {
  readonly api: ConnectorApi;
  readonly agentId: string;
  readonly intervalMs?: number;
  readonly log?: (message: string) => void;
  /** Override the Squire MCP (tests never spawn the real one). */
  readonly mcp?: SquireMcpClient;
  /** Override the install routine. */
  readonly install?: (options: InstallSquireOptions) => Promise<InstallSquireResult>;
  /** Override the vault reader. */
  readonly readVault?: (mcp: SquireMcpClient) => Promise<VaultConnectionMeta[]>;
  /** Override the grant revoker. */
  readonly revokeGrants?: (
    mcp: SquireMcpClient,
    ref: string,
  ) => Promise<{ revoked: number; failed: number }>;
  /** Override scheduling (tests advance a fake clock instead). */
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
};

export class ConnectorAssignmentLoop {
  private readonly agentId: string;
  private readonly api: ConnectorApi;
  private readonly intervalMs: number;
  private readonly log: (message: string) => void;
  private readonly install: (options: InstallSquireOptions) => Promise<InstallSquireResult>;
  private readonly readVaultFn: (mcp: SquireMcpClient) => Promise<VaultConnectionMeta[]>;
  private readonly revokeGrantsFn: (
    mcp: SquireMcpClient,
    ref: string,
  ) => Promise<{ revoked: number; failed: number }>;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private timer?: unknown;
  private started = false;
  private stopped = false;
  /** One install at a time per connector; other polls skip it. */
  private readonly inFlight = new Set<string>();
  private mcp?: SquireMcpClient;

  constructor(options: ConnectorAssignmentLoopOptions) {
    this.agentId = options.agentId;
    this.api = options.api;
    this.intervalMs = options.intervalMs ?? CONNECTOR_POLL_INTERVAL_MS;
    this.log = options.log ?? (() => {});
    this.install = options.install ?? installSquire;
    this.readVaultFn = options.readVault ?? readVault;
    this.revokeGrantsFn = options.revokeGrants ?? revokeGrants;
    this.schedule =
      options.schedule ??
      ((fn: () => void, ms: number) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return timer;
      });
    this.cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  }

  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    void this.runOnce();
    this.timer = this.schedule(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
  }

  /** One interval tick: poll, then re-arm. */
  private poll(): void {
    if (this.stopped) return;
    void this.runOnce();
    this.timer = this.schedule(() => this.poll(), this.intervalMs);
  }

  /** Drain the queue once; every failure is logged, never raised. */
  async runOnce(): Promise<void> {
    let assignments: readonly ConnectorAssignment[];
    try {
      const result = await this.api.execute('getConnectorAssignments', { agentId: this.agentId });
      assignments = result.assignments;
    } catch (error) {
      this.log(`connector assignments unavailable: ${describe(error)}`);
      return;
    }
    for (const assignment of assignments) {
      const key = `${assignment.kind}:${assignment.connectorId}`;
      if (assignment.kind === 'uninstall') continue; // the server reaps disconnected rows
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      void this.handle(assignment)
        .catch((error) => this.log(`connector assignment ${key} failed: ${describe(error)}`))
        .finally(() => this.inFlight.delete(key));
    }
  }

  private squire(): SquireMcpClient {
    this.mcp ??= defaultSquireMcpClient();
    return this.mcp;
  }

  private async handle(assignment: ConnectorAssignment): Promise<void> {
    if (assignment.kind === 'install') await this.runInstall(assignment.connectorId);
    else if (assignment.kind === 'sync') await this.runSync();
    else if (assignment.kind === 'revoke-grants')
      await this.runRevoke(assignment.connectorId, assignment.reference);
  }

  /** Install Trusty Squire, reporting every step as it settles. */
  private async runInstall(connectorId: string): Promise<void> {
    const report = async (steps: readonly ConnectorStep[]) => {
      try {
        await this.api.execute('postConnectorStatus', { agentId: this.agentId, connectorId, steps });
      } catch (error) {
        this.log(`step report failed: ${describe(error)}`);
      }
    };
    const result = await this.install({
      workspaceId: this.agentId,
      mcp: this.squire(),
      onProgress: report,
    });
    if (result.status === 'error') {
      await this.api.execute('postConnectorStatus', {
        agentId: this.agentId,
        connectorId,
        steps: result.steps,
        errorMessage: result.errorMessage,
      });
      return;
    }
    if (result.status === 'connected') {
      await this.api.execute('installConnector', {
        agentId: this.agentId,
        connectorId,
        ...(result.squireVersion ? { squireVersion: result.squireVersion } : {}),
        ...(result.signedInAs ? { signedInAs: result.signedInAs } : {}),
        ...(result.signIn ? { signIn: result.signIn } : {}),
      });
      await this.reportVault(connectorId);
      return;
    }
    // Still installing: the human has not signed in yet; keep the steps.
    await this.api.execute('postConnectorStatus', {
      agentId: this.agentId,
      connectorId,
      steps: result.steps,
      ...(result.squireVersion ? { squireVersion: result.squireVersion } : {}),
      ...(result.signedInAs ? { signedInAs: result.signedInAs } : {}),
      ...(result.signIn ? { signIn: result.signIn } : {}),
    });
  }

  /** One vault report covers every live trusty-squire connector on this helper. */
  private async runSync(): Promise<void> {
    await this.reportVault();
  }

  private async runRevoke(connectorId: string, reference: string): Promise<void> {
    const outcome = await this.revokeGrantsFn(this.squire(), reference);
    this.log(
      `revoked ${outcome.revoked} grant(s) on ${reference}` +
        (outcome.failed ? `, ${outcome.failed} failed` : ''),
    );
    void connectorId;
  }

  private async reportVault(_connectorId?: string): Promise<void> {
    const connections = await this.readVaultFn(this.squire());
    await this.api.execute('postConnectorVault', { agentId: this.agentId, connections });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
