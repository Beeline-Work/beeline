import { migrateMembershipSubscriptions } from './agent-subscriptions.js';

import { STARTER_BANTER_TYPING_MS, StarterOnboardingService } from './starter-onboarding-run.js';

import { starterHello, consumeStarterVideoPost, postStarterVideoPreview } from './starter-onboarding.js';

import { postRoomChoice } from './room-choice.js';

import { postRepositoryOnboarding } from './repository-onboarding.js';

import { TokenAuth } from './auth.js';

import { DaemonService } from './daemon-service.js';

import { createECDH } from 'node:crypto';

import { getPublicKey } from '@beeline/nostr';


import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimAgentCommand, createAgentCommand, type CommandRow } from './agent-command.js';

import {
  claimAgentConnection,
  releaseAgentConnection,
  releaseStaleServerConnections,
} from './connection-presence.js';

import { migrate } from './database.js';

import type { FreeAgentMachines, FreeAgentMachineSpec } from './fly-machines.js';

import {
  addFreeAgentToWorkspace,
  FREE_AGENT_EXIT_NOTE,
  FREE_AGENT_TURN_GUIDE,
  FREE_AGENT_HELLO,
  FREE_AGENT_JOIN_GREETING,
  FreeAgentService,
  generateAgentKeypair,
  openSecrets,
  freeAgentConfigFromEnv,
  type FreeAgentConfig,
} from './free-agents.js';

import { PushDeliveryLoop } from './background.js';

import { resolveCurrentMemberMentions } from './message-mentions.js';

import { LiveHub } from './live.js';

import { agentMachineOfflineSql } from './machine-offline.js';

import { PhoneService } from './phone-service.js';

import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';

import type { GitHubOperations } from './github-operations.js';

import { ObjectService } from './object-service.js';

import { PgliteDatabase, MemoryObjectStorage, migratedDatabase } from './test-support.js';

import { recordSigninFunnelEvent, recordOnboardingEvent } from './signin-funnel.js';

import { dashboardPeriods } from './operator-dashboard-periods.js';

import { reportSquireWork } from './squire-machine.js';


const sentryCaptures = vi.hoisted(() => [] as { error: unknown; tags: Record<string, string> | undefined }[]);

vi.mock('./sentry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sentry.js')>()),
  captureServerError: (error: unknown, tags?: Record<string, string>) => {
    sentryCaptures.push({ error, tags });
  },
}));


export const OWNER = 'a'.repeat(64);

export const FRIEND = 'b'.repeat(64);

const ORDINARY = 'c'.repeat(64);


export const TEST_FREE_AGENT_CONFIG: FreeAgentConfig = {
  model: 'deepseek/deepseek-v4-flash',
  idleSeconds: 60,
  maxPerOwner: 3,
  dailyTokenCap: 1_000_000,
  firstDayTokenCap: 1_000_000,
  lifetimeTokenCap: 3_000_000,
  sealSecret: 'test-seal-secret',
  publicOrigin: 'https://server.test',
  image: 'registry.fly.io/beeline-free-agents:test',
  region: 'iad',
  cpus: 1,
  memoryMb: 1024,
  reapIdleMs: 300_000,
  deleteAfterMs: 30 * 86_400_000,
};


/** Fly Machines stand-in: records every call and keeps each Machine's state. */
export class FakeMachines implements FreeAgentMachines {
  readonly calls: string[] = [];
  readonly specs: FreeAgentMachineSpec[] = [];
  readonly states = new Map<string, string>();
  failSuspend = false;
  failDestroy = false;
  beforeCreate?: () => Promise<void>;
  beforeDestroy?: () => Promise<void>;
  #next = 0;

  async create(spec: FreeAgentMachineSpec) {
    await this.beforeCreate?.();
    const id = `m${++this.#next}`;
    this.calls.push(`create ${spec.agentId.slice(0, 4)}`);
    this.specs.push(spec);
    this.states.set(id, 'started');
    return { id };
  }
  async find(agentId: string) {
    const index = this.specs.findIndex((spec) => spec.agentId === agentId);
    const id = index >= 0 ? `m${index + 1}` : undefined;
    const state = id ? this.states.get(id) : undefined;
    return id && state && state !== 'destroyed' ? { id, state } : undefined;
  }
  async start(id: string) {
    this.calls.push(`start ${id}`);
    this.states.set(id, 'started');
  }
  async refresh(id: string, _image: string, force = false) {
    if (!force && this.states.get(id) !== 'stopped') return false;
    await this.stop(id);
    await this.start(id);
    return true;
  }
  async suspend(id: string) {
    this.calls.push(`suspend ${id}`);
    if (this.failSuspend) throw new Error('suspend unavailable');
    this.states.set(id, 'suspended');
  }
  async stop(id: string) {
    this.calls.push(`stop ${id}`);
    this.states.set(id, 'stopped');
  }
  async destroy(id: string) {
    await this.beforeDestroy?.();
    this.calls.push(`destroy ${id}`);
    if (this.failDestroy) throw new Error('delete unavailable');
    this.states.set(id, 'destroyed');
  }
  async state(id: string) {
    const state = this.states.get(id);
    return state === 'destroyed' ? undefined : state;
  }
  async waitFor() {}
}


export async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 5));
}
export function fixtureScope1() {

  let db: PgliteDatabase;

  let live: LiveHub;

  let machines: FakeMachines;

  let freeAgents: FreeAgentService;

  let phone: PhoneService;

  let exchanges: string[];


  beforeEach(async () => {
    db = await migratedDatabase();
    live = new LiveHub();
    machines = new FakeMachines();
    sentryCaptures.length = 0;
    exchanges = [];
    freeAgents = new FreeAgentService(
      db,
      TEST_FREE_AGENT_CONFIG,
      machines,
      async (agentId) => {
        const token = `bde_${String(exchanges.length).padStart(43, '0')}`;
        exchanges.push(agentId);
        return { exchangeToken: token };
      },
      () => undefined,
    );
    phone = new PhoneService(db, 'https://server.test', undefined, undefined, live);
    phone.setFreeAgents(freeAgents);
    await db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
        ($1,'human','Charles','lunchboxfortwo'),($2,'human','Friend','friend')`,
      [OWNER, FRIEND],
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await settle();
    await db.close();
  });


  const finishWelcome = async (roomId: string, viewerId: string) => {
    await new StarterOnboardingService(db).enter(roomId, viewerId);
  };


  // Lifecycle tests start after the owner's first actual request, not the server hello.
  const createWorkspace = async (name = 'Fresh', viewer = OWNER) => {
    const result = await phone.execute('createWorkspace', { name }, viewer) as { id: string; roomId: string };
    await finishWelcome(result.roomId!, viewer);
    const agent = (await db.query<{ agent_id: string }>(`SELECT f.agent_id FROM free_agents f JOIN identities i ON i.id=f.agent_id WHERE workspace_id=$1 ORDER BY i.name`, [result.id])).rows[0];
    if (agent) {
      await createAgentCommand(db, { roomId: result.roomId, agentId: agent.agent_id, sourceMessageId: null, reason: 'human_tag' });
      await freeAgents.provision(agent.agent_id);
    }
    return result;
  };


  const freeAgentOf = async (workspaceId: string) =>
    (
      await db.query<{ agent_id: string; state: string; fly_machine_id: string | null }>(
        `SELECT f.agent_id,f.state,f.fly_machine_id FROM free_agents f JOIN identities i ON i.id=f.agent_id WHERE workspace_id=$1 ORDER BY i.name`,
        [workspaceId],
      )
    ).rows[0]!;
return {
get db(){return db;}, set db(value: typeof db){db=value;},
get live(){return live;}, set live(value: typeof live){live=value;},
get machines(){return machines;}, set machines(value: typeof machines){machines=value;},
get freeAgents(){return freeAgents;}, set freeAgents(value: typeof freeAgents){freeAgents=value;},
get phone(){return phone;}, set phone(value: typeof phone){phone=value;},
get exchanges(){return exchanges;}, set exchanges(value: typeof exchanges){exchanges=value;},
finishWelcome,
createWorkspace,
freeAgentOf,
};
}
export function fixtureScope2(scope1: ReturnType<typeof fixtureScope1>) {

    const passFence = (agentId: string) =>
      scope1.db.query(`UPDATE free_agents SET wake_requested_at=now()-interval '21 seconds' WHERE agent_id=$1`, [agentId]);

    const startOnce = async (agentId: string) => {
      await passFence(agentId);
      return scope1.freeAgents.wake(agentId);
    };

    const startNotices = async (roomId: string) =>
      (
        await scope1.db.query<{ author_id: string; text: string }>(
          `SELECT author_id,text FROM messages WHERE room_id=$1 AND text LIKE '%could not start%' ORDER BY created_at`,
          [roomId],
        )
      ).rows;
return {
passFence,
startOnce,
startNotices,
};
}
export { migrateMembershipSubscriptions } from './agent-subscriptions.js';
export { STARTER_BANTER_TYPING_MS, StarterOnboardingService } from './starter-onboarding-run.js';
export { starterHello, consumeStarterVideoPost, postStarterVideoPreview } from './starter-onboarding.js';
export { postRoomChoice } from './room-choice.js';
export { postRepositoryOnboarding } from './repository-onboarding.js';
export { TokenAuth } from './auth.js';
export { DaemonService } from './daemon-service.js';
export { createECDH } from 'node:crypto';
export { getPublicKey } from '@beeline/nostr';
export { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
export { claimAgentCommand, createAgentCommand } from './agent-command.js';
export { claimAgentConnection, releaseAgentConnection, releaseStaleServerConnections } from './connection-presence.js';
export { migrate } from './database.js';
export { addFreeAgentToWorkspace, FREE_AGENT_EXIT_NOTE, FREE_AGENT_TURN_GUIDE, FREE_AGENT_HELLO, FREE_AGENT_JOIN_GREETING, FreeAgentService, generateAgentKeypair, openSecrets, freeAgentConfigFromEnv } from './free-agents.js';
export { PushDeliveryLoop } from './background.js';
export { resolveCurrentMemberMentions } from './message-mentions.js';
export { LiveHub } from './live.js';
export { agentMachineOfflineSql } from './machine-offline.js';
export { PhoneService } from './phone-service.js';
export { AuthStore } from '@beeline/auth/store';
export { ObjectService } from './object-service.js';
export { PgliteDatabase, MemoryObjectStorage, migratedDatabase } from './test-support.js';
export { recordSigninFunnelEvent, recordOnboardingEvent } from './signin-funnel.js';
export { dashboardPeriods } from './operator-dashboard-periods.js';
export { reportSquireWork } from './squire-machine.js';
export type { CommandRow } from './agent-command.js';
export type { FreeAgentMachines, FreeAgentMachineSpec } from './fly-machines.js';
export type { FreeAgentConfig } from './free-agents.js';
export type { TransactionalDatabase } from '@beeline/auth/store';
export type { GitHubOperations } from './github-operations.js';

export { sentryCaptures };
