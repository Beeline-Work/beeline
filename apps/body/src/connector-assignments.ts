/**
 * The helper's connector work queue (Workbench PR 2).
 *
 * The server leaves one row per (connector, owner) in `pending_ops` whenever
 * a human pairs, revokes, or unpairs. `getConnectorAssignments` clears `sync`
 * on read; `revoke-grants` stays queued until this loop confirms the provider
 * drop. This loop is what makes that queue REAL on the helper: a Connect tap
 * pushes `connector-assignment` over the live socket, `wake()` drains then,
 * and a 5-minute poll is only recovery. The one thing nothing on the wire
 * announces is the human finishing a sign-in, so while this helper owns a
 * ceremony it watches that connect process locally and drains when it exits
 * (`CONNECT_WATCH_INTERVAL_MS`). It runs the Squire lifecycle
 * (`connector-squire.ts`) and reports each install step back through
 * `postConnectorStatus` so the phone paints progress live. A completed
 * install reports through `installConnector`, which flips the row to
 * `connected`, records the installed version, and clears the sign-in surface
 * — a run that reaches `connected` printed no ceremony, so no dead tunnel
 * survives it. A failed step reports its error.
 *
 * One helper carries ONE Squire account (captain decision 2026-09-14), so
 * after an install or a `sync` assignment the vault list is reported once
 * through `postConnectorVault` and covers every connector this helper serves.
 * The four Google tool connectors ride ONE grant: their installs share a
 * single credential resolution per drain and run one at a time.
 * One assignment at a time per connector; failures are logged, never raised —
 * the next drain retries, on the next push or the recovery poll.
 */
import type {
  ConnectorAssignment,
  ConnectorKind,
  ConnectorStatus,
  ConnectorStep,
  VaultConnectionMeta,
} from '@beeline/api-contract/daemon';
import {
  installGoogleTool,
  isGoogleToolConnectorType,
  persistManualGoogleCredentials,
  type InstallGoogleToolResult,
  type ResolvedGoogleCredentials,
} from './connector-google.js';
import { clearYoutubeGrant, isAdaptedYoutube } from './connector-adapters.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  CONNECT_TIMEOUT_MS,
  installSquire,
  isProcessAlive,
  releaseSquireConnectSession,
  readVault,
  revokeGrants,
  squireConnectSession,
  type InstallSquireOptions,
  type InstallSquireResult,
  type SquireMcpClient,
} from './connector-squire.js';
import { installTailscale, type InstallTailscaleResult } from './connector-tailscale.js';
import { defaultSquireMcpClient } from './squire-mcp-client.js';

export const CONNECTOR_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * How often the helper looks at a sign-in it OWNS. This is a local
 * `kill(pid, 0)` on the connect process, never a server read, and it exists
 * only while this helper is holding a ceremony open for a human: the row
 * stays `installing` until a LATER run reaches Squire's already-connected
 * short-circuit, and the only thing that says the human is finished is that
 * connect process exiting. It is armed when a ceremony is published and
 * disarmed the moment that process is gone, so an idle fleet runs no timer at
 * all and the five-minute interval stays pure recovery.
 */
export const CONNECT_WATCH_INTERVAL_MS = 2_000;

/** Said once, on the row, when a published ceremony ran out its own clock. */
export const CEREMONY_EXPIRED =
  'the Trusty Squire sign-in page expired before it was used · tap Retry to open a new one';

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
  /** Override the Tailscale install/sign-in routine. */
  readonly installTailscale?: (options: {
    onProgress: (steps: readonly ConnectorStep[]) => void;
    signIn?: ConnectorStatus['signIn'];
  }) => Promise<InstallTailscaleResult>;
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
  private readonly installTailscale: (options: {
    onProgress: (steps: readonly ConnectorStep[]) => void;
    signIn?: ConnectorStatus['signIn'];
  }) => Promise<InstallTailscaleResult>;
  private readonly googleHomeDir: string;
  private readonly readVaultFn: (mcp: SquireMcpClient) => Promise<VaultConnectionMeta[]>;
  private readonly revokeGrantsFn: (
    mcp: SquireMcpClient,
    ref: string,
  ) => Promise<{ revoked: number; failed: number }>;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private timer?: unknown;
  /** Armed only while this helper owns a live sign-in ceremony. */
  private connectWatch?: unknown;
  /** Armed only while a Tailscale browser login is waiting for its callback. */
  private tailscaleWatch?: unknown;
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
          : Promise.resolve({ source: 'pending', reason: 'waiting for Google sign-in' }),
      }));
    this.installTailscale = options.installTailscale ?? installTailscale;
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

  /** Event-driven drain. The interval stays the recovery net. */
  wake(): void {
    if (this.stopped) return;
    void this.runOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    if (this.connectWatch !== undefined) {
      this.cancel(this.connectWatch);
      this.connectWatch = undefined;
    }
    if (this.tailscaleWatch !== undefined) {
      this.cancel(this.tailscaleWatch);
      this.tailscaleWatch = undefined;
    }
  }

  /**
   * Watch the sign-in this helper is holding open. The phone paints
   * `installing` for the whole ceremony and only a drain that reaches
   * Squire's already-connected short-circuit flips the row to `connected`;
   * nothing on the wire announces that the human finished, so the connect
   * process exiting is the signal. Drain on that, and the row settles on the
   * same cadence it always has instead of waiting out the recovery poll.
   */
  private watchConnectSignIn(): void {
    if (this.stopped || this.connectWatch !== undefined) return;
    if (!this.connectCeremonyLive()) return;
    this.connectWatch = this.schedule(() => this.checkConnectSignIn(), CONNECT_WATCH_INTERVAL_MS);
  }

  /** A ceremony of ours still worth waiting on: claimed, unspent, alive. */
  private connectCeremonyLive(): boolean {
    const claim = squireConnectSession();
    if (!claim) return false;
    if (Date.now() - claim.claimedAt >= CONNECT_TIMEOUT_MS) return false;
    return isProcessAlive(claim.pid);
  }

  private checkConnectSignIn(): void {
    this.connectWatch = undefined;
    if (this.stopped) return;
    if (this.connectCeremonyLive()) {
      this.connectWatch = this.schedule(() => this.checkConnectSignIn(), CONNECT_WATCH_INTERVAL_MS);
      return;
    }
    // The connect process is gone — the human signed in, closed the page, or
    // the ceremony outlived its own tunnel. Every one of those is answered by
    // the next drain, now rather than in five minutes.
    void this.runOnce();
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
    const youtubeRows = assignments.filter((assignment) =>
      isAdaptedYoutube(assignment.connectorType));
    if (youtubeRows.some((assignment) => assignment.kind === 'uninstall') &&
      youtubeRows.every((assignment) => assignment.kind === 'uninstall')) {
      clearYoutubeGrant(this.googleHome(), (message) => this.log(message));
    }
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
      void this.handle(assignment)
        .catch((error) => this.log(`connector assignment ${key} failed: ${describe(error)}`))
        .finally(() => this.inFlight.delete(key));
    }
    if (googleBatch) {
      const keys = googleBatch.map((assignment) => `${assignment.kind}:${assignment.connectorId}`);
      void this.runGoogleBatch(googleBatch)
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
    const sharedCredentials = () =>
      (shared ??= this.resolveGoogleCredentials(batch[0]!.connectorId));
    for (const assignment of batch) {
      await this.runGoogleInstall(
        assignment.connectorId,
        assignment.connectorType,
        sharedCredentials,
        assignment.kind === 'install' ? assignment.pairingGeneration : undefined,
      );
    }
  }

  /** The ONE grant resolution shared by every Google tool install of a
   * drain: the Squire one-click vault path first, then the manual
   * credentials path. Never rejects — a failure resolves as an unusable
   * grant each install reports through its own steps. */
  private resolveGoogleCredentials(connectorId: string): Promise<ResolvedGoogleCredentials> {
    return (async () => {
      try {
        const grant = await this.api.execute('getGoogleOAuthGrant', {
          agentId: this.agentId, connectorId,
        });
        if (grant.status === 'ready' && grant.credentials)
          return { source: 'beeline', credentials: grant.credentials };
      } catch (error) {
        this.log(`Google grant lookup failed: ${describe(error)}`);
        return { source: 'error', reason: 'Beeline could not read the Google grant; retry the connection' };
      }
      return { source: 'pending', reason: 'waiting for Google sign-in' };
    })();
  }

  private squire(): SquireMcpClient {
    this.mcp ??= defaultSquireMcpClient();
    return this.mcp;
  }

  private async handle(assignment: ConnectorAssignment): Promise<void> {
    const pairingGeneration =
      assignment.kind === 'install' || assignment.kind === 'uninstall'
        ? assignment.pairingGeneration
        : undefined;
    if (assignment.kind === 'install') {
      if (assignment.connectorType === 'tailscale') {
        await this.runTailscaleInstall(assignment.connectorId, pairingGeneration);
      } else {
        await this.runInstall(assignment.connectorId, pairingGeneration);
      }
    } else if (assignment.kind === 'sync' && assignment.connectorType !== 'tailscale') {
      await this.runSync();
    } else if (assignment.kind === 'refresh-google-grant') {
      const grant = await this.resolveGoogleCredentials(assignment.connectorId);
      if ('credentials' in grant)
        persistManualGoogleCredentials(this.googleHome(), grant.credentials);
    } else if (assignment.kind === 'revoke-grants')
      await this.runRevoke(assignment.connectorId, assignment.reference);
  }

  /** Install Tailscale and publish its browser login URL until the tailnet is connected. */
  private async runTailscaleInstall(
    connectorId: string,
    pairingGeneration?: number,
  ): Promise<void> {
    const generation = pairingGeneration !== undefined ? { pairingGeneration } : {};
    const report = async (steps: readonly ConnectorStep[]) => {
      try {
        await this.api.execute('postConnectorStatus', {
          agentId: this.agentId,
          connectorId,
          steps,
          ...generation,
        });
      } catch (error) {
        this.log(`step report failed: ${describe(error)}`);
      }
    };
    const existing = await this.connectorRow(connectorId);
    const result = await this.installTailscale({
      onProgress: report,
      ...(existing?.signIn ? { signIn: existing.signIn } : {}),
    });
    if (result.status === 'connected') {
      if (this.tailscaleWatch !== undefined) {
        this.cancel(this.tailscaleWatch);
        this.tailscaleWatch = undefined;
      }
      await this.api.execute('installConnector', {
        agentId: this.agentId,
        connectorId,
        ...(result.signedInAs ? { signedInAs: result.signedInAs } : {}),
        ...generation,
      });
      return;
    }
    await this.api.execute('postConnectorStatus', {
      agentId: this.agentId,
      connectorId,
      steps: result.steps,
      signIn: result.status === 'installing' ? result.signIn : null,
      ...(result.status === 'error' ? { errorMessage: result.errorMessage } : {}),
      ...generation,
    });
    if (result.status === 'installing' && this.tailscaleWatch === undefined) {
      this.tailscaleWatch = this.schedule(() => {
        this.tailscaleWatch = undefined;
        if (!this.stopped) void this.runOnce();
      }, CONNECT_WATCH_INTERVAL_MS);
    }
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
    pairingGeneration?: number,
  ): Promise<void> {
    const generation = pairingGeneration !== undefined ? { pairingGeneration } : {};
    const report = async (steps: readonly ConnectorStep[]) => {
      try {
        await this.api.execute('postConnectorStatus', {
          agentId: this.agentId,
          connectorId,
          steps,
          ...generation,
        });
      } catch (error) {
        this.log(`step report failed: ${describe(error)}`);
      }
    };
    const result = await this.installGoogle(connectorType, report, sharedCredentials);
    if (result.status === 'installing') return;
    if (result.status === 'error') {
      if (isAdaptedYoutube(connectorType)) {
        clearYoutubeGrant(this.googleHome(), (message) => this.log(message));
      }
      await this.api.execute('postConnectorStatus', {
        agentId: this.agentId,
        connectorId,
        steps: result.steps,
        errorMessage: result.errorMessage,
        ...generation,
      });
      return;
    }
    await this.api.execute('installConnector', {
      agentId: this.agentId,
      connectorId,
      ...(result.signedInAs ? { signedInAs: result.signedInAs } : {}),
      ...generation,
    });
  }

  /** Install Trusty Squire, reporting every step as it settles. */
  private async runInstall(connectorId: string, pairingGeneration?: number): Promise<void> {
    const generation = pairingGeneration !== undefined ? { pairingGeneration } : {};
    // The row stays `installing` for the whole time the human is signing in,
    // and the server re-issues this assignment on EVERY poll until it leaves
    // that state. A connect this helper spawned and still owns IS that
    // ceremony: starting another one releases the claim, which SIGTERMs the
    // process group and takes the noVNC tunnel the phone is displaying down
    // with it. That protection is bounded by the ceremony's own life — past
    // it the tunnel is no use to anybody, and an abandoned connect would hold
    // its Xvfb/x11vnc/websockify/cloudflared rig for the daemon's lifetime.
    const claim = squireConnectSession();
    const spent = claim ? Date.now() - claim.claimedAt >= CONNECT_TIMEOUT_MS : false;
    if (claim && !spent && isProcessAlive(claim.pid)) {
      if (!(await this.rearmedByHuman(connectorId))) {
        this.log(
          `trusty-squire connect still waiting for sign-in (pid ${String(claim.pid)}); leaving it alone`,
        );
        this.watchConnectSignIn();
        return;
      }
      this.log('trusty-squire re-pair requested; superseding the connect holding the browser');
    } else if (spent && (await this.connectorRow(connectorId))?.signIn) {
      // The ceremony this helper published outlived its own tunnel with
      // nobody signing in. The row is still `installing`, so the server keeps
      // re-issuing this assignment; starting another connect would raise
      // another Xvfb/x11vnc/websockify/cloudflared rig every five minutes
      // forever. Stop the row and say why — Retry re-arms it.
      releaseSquireConnectSession((message) => this.log(`[trusty-squire] ${message}`));
      await this.api.execute('postConnectorStatus', {
        agentId: this.agentId,
        connectorId,
        steps: [{ label: 'waiting for sign-in', status: 'failed', reason: CEREMONY_EXPIRED }],
        signIn: null,
        errorMessage: CEREMONY_EXPIRED,
        ...generation,
      });
      return;
    }
    const report = async (steps: readonly ConnectorStep[]) => {
      try {
        await this.api.execute('postConnectorStatus', {
          agentId: this.agentId,
          connectorId,
          steps,
          ...generation,
        });
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
        signIn: null,
        errorMessage: result.errorMessage,
        ...generation,
      });
      return;
    }
    if (result.status === 'connected') {
      await this.api.execute('installConnector', {
        agentId: this.agentId,
        connectorId,
        ...(result.squireVersion ? { squireVersion: result.squireVersion } : {}),
        ...generation,
      });
      await this.reportVault(connectorId);
      return;
    }
    // Still installing: the human has not signed in yet; keep the steps. This
    // run's verdict on the ceremony is explicit — `null` when it printed none,
    // so a tunnel a PREVIOUS run left on the row dies with that run.
    await this.api.execute('postConnectorStatus', {
      agentId: this.agentId,
      connectorId,
      steps: result.steps,
      signIn: result.signIn ?? null,
      ...(result.squireVersion ? { squireVersion: result.squireVersion } : {}),
      ...generation,
    });
    this.watchConnectSignIn();
  }

  /** This connector's own row, or undefined when the server cannot answer. */
  private async connectorRow(connectorId: string): Promise<ConnectorStatus | undefined> {
    try {
      const status = await this.api.execute('getConnectorStatus', {
        agentId: this.agentId,
        connectorId,
      });
      return status.connectorId === connectorId ? status : undefined;
    } catch (error) {
      this.log(`connector status unavailable: ${describe(error)}`);
      return undefined;
    }
  }

  /**
   * True when a human asked for this connector again while a connect of ours
   * still holds the browser. `pairConnector` re-arms the row to its default
   * all-pending steps, so a row whose every step is still pending is a fresh
   * request; the row carrying the ceremony this helper published has settled
   * ones. An unreadable row is not evidence of a retry.
   */
  private async rearmedByHuman(connectorId: string): Promise<boolean> {
    const status = await this.connectorRow(connectorId);
    if (!status) return false;
    return status.steps.length > 0 && status.steps.every((step) => step.status === 'pending');
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
    if (outcome.failed) return;
    await this.api.execute('revokeConnectionGrants', {
      agentId: this.agentId,
      ref: reference,
    });
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
