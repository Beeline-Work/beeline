import type { WebSocket } from 'ws';
import { HELPER_UPDATE_CLOSE_CODE, HELPER_UPDATE_CLOSE_REASON } from '@beeline/api-contract/daemon';
import { helperVersionBelowMinimum } from './helper-version-gate.js';
import { DaemonAgentSession, type DaemonLiveDependencies } from './daemon-live.js';
export const MAX_MACHINE_AGENTS = 64;
export const MACHINE_SOCKET_PROTOCOL = 'beeline.machine.1';
/** The helper version a daemon socket reported, and the server minimum it is held to. */
class HelperVersionGuard {
  #pushedMinimum: string | undefined;
  readonly #release: () => void;

  constructor(
    private readonly deps: DaemonLiveDependencies,
    private version: string | undefined,
    private readonly send: (payload: string) => void,
    private readonly close: (code: number, reason: string) => void,
  ) {
    this.#release = deps.helperVersionGate.subscribe((minimum) => {
      if (this.#forceUpdate(minimum)) close(HELPER_UPDATE_CLOSE_CODE, HELPER_UPDATE_CLOSE_REASON);
    });
  }

  learn(version: string): void {
    this.version ??= version;
  }

  #forceUpdate(minimum: string): boolean {
    if (!helperVersionBelowMinimum(this.version, minimum) || this.#pushedMinimum === minimum)
      return false;
    this.#pushedMinimum = minimum;
    this.deps.counters.helperForceUpdates++;
    this.send(JSON.stringify({ type: 'force-update', minVersion: minimum }));
    return true;
  }

  /** False when the socket was closed for its version. */
  admit(): boolean {
    const minimum = this.deps.helperVersionGate.minimum;
    if (!minimum) return true;
    if (this.#forceUpdate(minimum) || helperVersionBelowMinimum(this.version, minimum)) {
      this.deps.counters.helperVersionRefusals++;
      this.close(HELPER_UPDATE_CLOSE_CODE, HELPER_UPDATE_CLOSE_REASON);
      return false;
    }
    return true;
  }

  dispose(): void {
    this.#release();
  }
}

type SendLive = (payload: string) => void;

function frameBytes(raw: Buffer | ArrayBuffer | Buffer[]): number {
  return Array.isArray(raw) ? raw.reduce((total, part) => total + part.length, 0) : raw.byteLength;
}

function parseFrame(raw: Buffer | ArrayBuffer | Buffer[]): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(
      Array.isArray(raw) ? Buffer.concat(raw).toString() : Buffer.from(raw as ArrayBuffer).toString(),
    ) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A pre-machine helper: one socket authenticated as one agent at upgrade.
 * It is one session; the socket's frames carry no agent id.
 */
export function serveAgentSocket(
  deps: DaemonLiveDependencies,
  client: WebSocket,
  principal: { identityId: string; helperVersion?: string; helperSourceSha?: string },
  sendLive: SendLive,
  trackSubscriptions: (count: () => number) => void,
): void {
  const guard = new HelperVersionGuard(
    deps, principal.helperVersion, sendLive, (code, reason) => client.close(code, reason),
  );
  const isOpen = () => client.readyState === client.OPEN;
  const send = (event: Record<string, unknown>) => {
    if (isOpen()) sendLive(JSON.stringify(event));
  };
  sendLive(JSON.stringify({
    type: 'hello',
    protocolMin: 1,
    protocolMax: 1,
    capabilities: { discoveryWake: true, pushIntake: true },
    ...(principal.helperVersion ? { reportedHelper: {
      releaseVersion: principal.helperVersion,
      ...(principal.helperSourceSha ? { sourceSha: principal.helperSourceSha } : {}),
    } } : {}),
  }));
  const session = new DaemonAgentSession(deps, principal.identityId, {
    send,
    isOpen,
    drop: (code, reason) => {
      // A newer connection replaced this socket: it holds nothing worth a
      // graceful close, and its count was already released at upgrade.
      if (code === 4001) client.terminate();
      else if (isOpen()) client.close(code, reason);
    },
    admit: (item) => {
      if (item.type === 'subscribe' && typeof item.releaseVersion === 'string')
        guard.learn(item.releaseVersion);
      return guard.admit();
    },
  });
  void session.claim();
  trackSubscriptions(() => session.subscriptions);
  const releaseSubscription = deps.releaseNotify?.subscribeHelperRelease((release) =>
    send({ type: 'helper-release', version: release.version, sha: release.sha }),
  );
  client.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    if (!guard.admit()) return;
    const bytes = frameBytes(raw);
    const item = parseFrame(raw);
    if (!item) {
      deps.errors.invalid++;
      return;
    }
    session.frame(item, bytes);
  });
  client.on('close', (code, reason) => {
    guard.dispose();
    releaseSubscription?.();
    session.close(code === HELPER_UPDATE_CLOSE_CODE && reason.toString() === HELPER_UPDATE_CLOSE_REASON);
  });
}

/**
 * One socket for every agent on a helper machine. The socket itself carries no
 * identity: each agent registers with its own daemon token, and a refused,
 * revoked or overloaded agent loses only its own registration.
 */
export function serveMachineSocket(
  deps: DaemonLiveDependencies,
  client: WebSocket,
  principal: { helperVersion?: string; helperSourceSha?: string },
  sendLive: SendLive,
  trackSubscriptions: (count: () => number) => void,
): void {
  const sessions = new Map<string, DaemonAgentSession>();
  const registering = new Set<string>();
  const guard = new HelperVersionGuard(
    deps, principal.helperVersion, sendLive, (code, reason) => client.close(code, reason),
  );
  const isOpen = () => client.readyState === client.OPEN;
  const send = (event: Record<string, unknown>) => {
    if (isOpen()) sendLive(JSON.stringify(event));
  };
  trackSubscriptions(() => [...sessions.values()].reduce((sum, session) => sum + session.subscriptions, 0));
  send({
    type: 'hello',
    protocol: 'machine',
    protocolMin: 1,
    protocolMax: 1,
    capabilities: { discoveryWake: true, pushIntake: true },
    ...(principal.helperVersion ? { reportedHelper: {
      releaseVersion: principal.helperVersion,
      ...(principal.helperSourceSha ? { sourceSha: principal.helperSourceSha } : {}),
    } } : {}),
  });
  const releaseSubscription = deps.releaseNotify?.subscribeHelperRelease((release) =>
    send({ type: 'helper-release', version: release.version, sha: release.sha }),
  );
  const unregistered = (agentId: string, reason: string, code?: number) =>
    send({ type: 'unregistered', agentId, reason, ...(code ? { code } : {}) });

  const register = async (item: Record<string, unknown>, reply = send) => {
    const agentId = item.agentId;
    const token = item.token;
    if (typeof agentId !== 'string' || !/^[0-9a-f]{64}$/i.test(agentId)) {
      deps.errors.invalid++;
      return;
    }
    if (typeof token !== 'string' || !token.startsWith('bdt_')) {
      reply({ type: 'register-refused', agentId, code: 'daemon_token_required' });
      return;
    }
    if (registering.has(agentId)) return;
    if (!sessions.has(agentId) && sessions.size + registering.size >= MAX_MACHINE_AGENTS) {
      deps.errors.overload++;
      reply({ type: 'register-refused', agentId, code: 'too_many_agents' });
      return;
    }
    registering.add(agentId);
    const registrationStartedAt = Date.now();
    let registrationStage = 'authentication';
    try {
      const authenticated = await deps.auth.authenticateDaemon(token);
      if (!isOpen()) return;
      if (authenticated !== agentId) {
        // The same two answers HTTP gives: a settled removal, or a token to retry.
        registrationStage = 'retirement-check';
        const retired = authenticated ? null : await deps.auth.retiredDaemonAgent(token);
        reply({
          type: 'register-refused',
          agentId,
          code: retired ? 'agent_removed' : 'daemon_token_required',
        });
        return;
      }
      registrationStage = 'session-setup';
      sessions.get(agentId)?.close();
      const session: DaemonAgentSession = new DaemonAgentSession(
        deps,
        agentId,
        {
          send: (event) => send({ ...event, agentId }),
          isOpen: (): boolean => isOpen() && sessions.get(agentId) === session,
          drop: (code, reason) => {
            if (sessions.get(agentId) !== session) return;
            sessions.delete(agentId);
            unregistered(agentId, reason, code);
          },
          admit: () => guard.admit(),
          authenticateOperation: async () => {
            if (await deps.auth.authenticateDaemon(token) === agentId) return undefined;
            client.close(4003,'machine login changed');
            return await deps.auth.retiredDaemonAgent(token)
              ? {error: 'agent_removed', status: 403} : {error: 'daemon_token_required', status: 401};
          },
        },
        {
          ...(typeof item.lifecycleId === 'string' && item.lifecycleId.length <= 128
            ? { lifecycleId: item.lifecycleId } : {}),
          ...(typeof item.releaseVersion === 'string' ? { releaseVersion: item.releaseVersion } : {}),
          ...(typeof item.sourceSha === 'string' ? { sourceSha: item.sourceSha } : {}),
          ...(typeof item.available === 'boolean' ? { available: item.available } : {}),
          ...(item.overlayV1===true?{overlayV1:true}:{}),
          ...(item.usageAccountV1===true?{usageAccountV1:true}:{}),
          ...(item.activationContextV1===true?{activationContextV1:true}:{}),
          ...(item.turnOwnershipV1===true?{turnOwnershipV1:true}:{}),
          ...(item.ownedModelV1===true?{ownedModelV1:true}:{}),
          ...(item.daemonOperationsV1===true?{daemonOperationsV1:true}:{}),
        },
      );
      sessions.set(agentId, session);
      registrationStage = 'presence-claim';
      await session.claim();
      if (session.closed || sessions.get(agentId) !== session) return;
      reply({
        type: 'registered',
        agentId,
        capabilities: { initialSnapshotsV1: true, discoveryWake: true, pushIntake: true,
          ...(item.daemonOperationsV1 === true ? {daemonOperationsV1:true} : {}),
          ...(session.turnOwnershipV1 ? {turnOwnershipV1:true,turnConnectionId:session.turnSource!.connectionId,turnConnectionEpoch:session.turnSource!.epoch,turnContinuationV1:session.turnContinuationV1} : {}),
          ...(session.ownedModelV1 ? {ownedModelV1:true} : {}),
          ...(session.overlayV1?{overlayV1:true}:{}),
          ...(session.activationContextV1?{activationContextV1:true,activationConnectionId:session.connectionId,activationConnectionEpoch:session.epoch}:{}),
          ...(session.usageAccountV1?{usageAccountV1:true,usageOwnerId:session.usageOwnerId,usageConnectionId:session.connectionId,usageConnectionEpoch:session.epoch}:{}) },
      });
    } catch (error) {
      deps.errors.internal++;
      console.error('[live] agent registration failed', JSON.stringify({
        agentId, stage: registrationStage, elapsedMs: Date.now() - registrationStartedAt,
        helperSourceSha: principal.helperSourceSha,
      }), error instanceof Error ? error.message : String(error));
      if (isOpen()) reply({ type: 'register-refused', agentId, code: 'registration_failed' });
    } finally {
      registering.delete(agentId);
    }
  };

  client.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    if (!guard.admit()) return;
    const bytes = frameBytes(raw);
    const item = parseFrame(raw);
    if (!item) {
      deps.errors.invalid++;
      return;
    }
    if (item.type === 'register-machine' && Array.isArray(item.agents) && item.agents.length <= MAX_MACHINE_AGENTS) {
      const agents: Record<string,unknown>[] = [];
      void Promise.all(item.agents.map(agent => agent && typeof agent === 'object'
        ? register(agent, event => { agents.push(event); }) : undefined)).then(() => send({type:'registered-machine',agents}));
      return;
    }
    if (item.type === 'register') {
      void register(item);
      return;
    }
    const agentId = typeof item.agentId === 'string' ? item.agentId : undefined;
    const session = agentId ? sessions.get(agentId) : undefined;
    if (!session) {
      deps.errors.invalid++;
      return;
    }
    if (item.type === 'unregister') {
      sessions.delete(session.agentId);
      session.close();
      return;
    }
    session.frame(item, bytes);
  });
  client.on('close', (code, reason) => {
    guard.dispose();
    releaseSubscription?.();
    const forUpdate = code === HELPER_UPDATE_CLOSE_CODE && reason.toString() === HELPER_UPDATE_CLOSE_REASON;
    for (const session of sessions.values()) session.close(forUpdate);
    sessions.clear();
  });
}

/** The physical machine output owner. Backpressure refuses admission without
 * closing an otherwise live machine. Socket close remains login/version-only. */
export function machineConnectionOutput(client:WebSocket,limit:number,onOverload:()=>void):(payload:string)=>boolean {
  return payload=>{
    if(client.readyState!==client.OPEN)return false;
    if(client.bufferedAmount+Buffer.byteLength(payload)>limit){onOverload();return false;}
    client.send(payload);return true;
  };
}
