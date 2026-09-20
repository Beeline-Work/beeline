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
 * The four Google tool connectors ride ONE grant: their installs share a
 * single credential resolution per drain and run one at a time.
 * One assignment at a time per connector; failures are logged, never raised —
 * the next poll retries.
 */
import type {
  ConnectorAssignment,
  ConnectorKind,
  ConnectorStep,
  VaultConnectionMeta,
} from '@beeline/api-contract/daemon';
import {
  installGoogleTool,
  isGoogleToolConnectorType,
  loadManualGoogleCredentials,
  readGoogleCredentialsFromVault,
  type InstallGoogleToolResult,
  type ResolvedGoogleCredentials,
} from './connector-google.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  installSquire,
  isProcessAlive,
  isSquireBrowserSessionFailure,
  readVault,
  revokeGrants,
  squireConnectSession,
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
  /** Override the Squire install routine. */
  readonly install?: (options: InstallSquireOptions) => Promise<InstallSquireResult>;
  /** Override the Google tool install routine. The third argument is the
   * drain's SHARED grant-resolution factory: the single Google consent is
   * resolved once and every Google tool install in the batch rides it. */
  readonly installGoogle?: (
    connectorType: ConnectorKind,
    onProgress: (steps: readonly ConnectorStep[]) => void,
    sharedCredentials?: () => Promise<ResolvedGoogleCredentials>,
  ) => Promise<InstallGoogleToolResult>;
  /** Where manual google-credentials.json lives (defaults to the runtime home). */
  readonly googleHome?: string;
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
  private readonly installGoogle: (
    connectorType: ConnectorKind,
    onProgress: (steps: readonly ConnectorStep[]) => void,
    sharedCredentials?: () => Promise<ResolvedGoogleCredentials>,
  ) => Promise<InstallGoogleToolResult>;
  private readonly googleHomeDir: string;
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
    this.installGoogle = options.installGoogle ?? ((connectorType, onProgress, sharedCredentials) =>
      installGoogleTool({
        connectorType,
        home: this.googleHome(),
        onProgress,
        resolvedCredentials: sharedCredentials
          ? sharedCredentials()
          : this.resolveGoogleCredentials(),
      }));
    this.googleHomeDir = options.googleHome ?? process.env.BEELINE_AGENT_HOME ?? process.cwd();
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
    const squireWork: Promise<void>[] = [];
    let googleBatch: ConnectorAssignment[] | undefined;
    for (const assignment of assignments) {
      const key = `${assignment.kind}:${assignment.connectorId}`;
      if (assignment.kind === 'uninstall') continue; // the server reaps disconnected rows
      // Google tool installs do not race each other or their siblings: one
      // drain runs them as ONE sequential batch behind ONE shared grant
      // resolution — the single Google consent — instead of four parallel
      // install processes on the machine (one-connector-per-machine pairing
      // is preserved; each tool still fails independently).
      if (assignment.kind === 'install' && isGoogleToolConnectorType(assignment.connectorType)) {
        if (this.inFlight.has(key)) continue;
        this.inFlight.add(key);
        (googleBatch ??= []).push(assignment);
        continue;
      }
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      squireWork.push(
        this.handle(assignment)
          .catch((error) => this.log(`connector assignment ${key} failed: ${describe(error)}`))
          .finally(() => this.inFlight.delete(key)),
      );
    }
    if (googleBatch) {
      // A Google vault lookup must not race a Squire connect for the one
      // browser claim: wait for this drain's Squire work to settle first.
      const keys = googleBatch.map((assignment) => `${assignment.kind}:${assignment.connectorId}`);
      void Promise.all(squireWork)
        .then(() => this.runGoogleBatch(googleBatch!))
        .catch((error) => this.log(`google connector installs failed: ${describe(error)}`))
        .finally(() => {
          for (const key of keys) this.inFlight.delete(key);
        });
    }
  }

  /** The Google tool connectors ride ONE grant: every install in the batch
   * shares one credential resolution (the single Google consent) and the
   * installs run one at a time. Each tool still verifies and fails
   * independently — a grant that cannot serve one tool's scope refuses that
   * tool alone, never its siblings. */
  private async runGoogleBatch(batch: readonly ConnectorAssignment[]): Promise<void> {
    let shared: Promise<ResolvedGoogleCredentials> | undefined;
    const sharedCredentials = () => (shared ??= this.resolveGoogleCredentials());
    for (const assignment of batch) {
      await this.runGoogleInstall(
        assignment.connectorId,
        assignment.connectorType,
        sharedCredentials,
      );
    }
  }

  /** The ONE grant resolution shared by every Google tool install of a
   * drain: the Squire one-click vault path first, then the manual
   * credentials path. Never rejects — a failure resolves as an unusable
   * grant each install reports through its own steps. */
  private resolveGoogleCredentials(): Promise<ResolvedGoogleCredentials> {
    return (async () => {
      try {
        const oneClick = await readGoogleCredentialsFromVault(this.squire());
        if (oneClick.source === 'squire') return oneClick;
        if (isSquireBrowserSessionFailure(oneClick.reason)) return oneClick;
      } catch (error) {
        this.log(`google one-click grant lookup failed: ${describe(error)}`);
      }
      return loadManualGoogleCredentials(this.googleHome(), process.env);
    })();
  }

  private squire(): SquireMcpClient {
    this.mcp ??= defaultSquireMcpClient();
    return this.mcp;
  }

  private async handle(assignment: ConnectorAssignment): Promise<void> {
    if (assignment.kind === 'install') {
      await this.runInstall(assignment.connectorId);
    } else if (assignment.kind === 'sync') await this.runSync();
    else if (assignment.kind === 'revoke-grants')
      await this.runRevoke(assignment.connectorId, assignment.reference);
  }

  /** Google tool connectors keep their manual credentials next to the runtime. */
  private googleHome(): string {
    return this.googleHomeDir;
  }

  /** Install one Google tool connector (Gmail/Calendar/Drive/YouTube),
   * riding the drain's shared grant resolution. */
  private async runGoogleInstall(
    connectorId: string,
    connectorType: ConnectorKind,
    sharedCredentials: () => Promise<ResolvedGoogleCredentials>,
  ): Promise<void> {
    const report = async (steps: readonly ConnectorStep[]) => {
      try {
        await this.api.execute('postConnectorStatus', { agentId: this.agentId, connectorId, steps });
      } catch (error) {
        this.log(`step report failed: ${describe(error)}`);
      }
    };
    const result = await this.installGoogle(connectorType, report, sharedCredentials);
    if (result.status === 'error') {
      await this.api.execute('postConnectorStatus', {
        agentId: this.agentId,
        connectorId,
        steps: result.steps,
        errorMessage: result.errorMessage,
      });
      return;
    }
    await this.api.execute('installConnector', {
      agentId: this.agentId,
      connectorId,
      ...(result.signedInAs ? { signedInAs: result.signedInAs } : {}),
    });
  }

  /** Install Trusty Squire, reporting every step as it settles. */
  private async runInstall(connectorId: string): Promise<void> {
    // The row stays `installing` for the whole time the human is signing in,
    // and the server re-issues this assignment on EVERY poll until it leaves
    // that state. A connect this helper spawned and still owns IS that
    // ceremony: starting another one releases the claim, which SIGTERMs the
    // process group and takes the noVNC tunnel the phone is displaying down
    // with it. The surface already posted stays live and stays on the row.
    const claim = squireConnectSession();
    if (claim && isProcessAlive(claim.pid)) {
      this.log(
        `trusty-squire connect still waiting for sign-in (pid ${String(claim.pid)}); leaving it alone`,
      );
      return;
    }
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
      log: (message) => this.log(`[trusty-squire] ${message}`),
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
