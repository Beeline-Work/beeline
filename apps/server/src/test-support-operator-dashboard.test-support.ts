import { phoneFetch } from '../../../tests/helpers/phone-operation.js';

import type { AddressInfo } from 'node:net';

import type { randomUUID } from 'node:crypto';

import { recordSigninFunnelEvent } from './signin-funnel.js';

import { createSigninFunnelClient } from '@beeline/api-contract/signin-funnel-client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PgliteDatabase, migratedDatabase } from './test-support.js';

import { createBeelineServer } from './server.js';

import { dashboardHealth, dashboardOps } from './operator-dashboard.js';

import { dashboardOverview } from './operator-dashboard-overview.js';

import { REVIEW_IDENTITY_ID } from './review-access.js';

import { QueryWindow } from './query-profile.js';

import type { SqlDatabase } from './database.js';

import type { TokenAuth } from './auth.js';

import type { PhoneService } from './phone-service.js';

import { claimAgentCommand, createAgentCommand } from './agent-command.js';

import { DaemonService } from './daemon-service.js';

import { LiveHub } from './live.js';

import { dashboardCoreMetrics } from './operator-dashboard-core-metrics.js';


export const workspace = '10000000-0000-4000-8000-000000000801';

export const room = '20000000-0000-4000-8000-000000000801';

export const secret = 'a private message that must never leave the database';

export let db: PgliteDatabase;

export let server: ReturnType<typeof createBeelineServer>;

export let base: string;


beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Dashboard test')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Main')`, [room, workspace]);
  server = createBeelineServer({
    database: db,
    dashboardSecret: 'dashboard-only-secret',
    auth: {
      authenticatePhone: async (value: string) =>
        value === 'phone-key-for-dashboard-test' ? 'viewer' : null,
    } as TokenAuth,
    phone: {} as PhoneService,
    daemon: {} as DaemonService,
    live: new LiveHub(),
    mediaMaximumBytes: 1,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});


export function get(query = '', key = 'dashboard-only-secret') {
  return phoneFetch(`${base}/v1/admin/dashboard${query}`, {
    headers: { authorization: `Bearer ${key}` },
  });
}

export async function seed() {
  for (let index = 1; index <= 12; index++) {
    const human = `a${index.toString(16).padStart(63, '0')}`;
    const agent = `b${index.toString(16).padStart(63, '0')}`;
    const platform = index <= 6 ? 'ios' : 'android';
    await db.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Person'),($2,'agent','Agent')`,
      [human, agent],
    );
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await db.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member'),($1,$3,'member')`,
      [workspace, human, agent],
    );
    await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [
      index.toString(16).padStart(64, '0'),
      agent,
    ]);
    await db.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES($1,$2,$3,'physical')`,
      [`push-${index}`, human, platform],
    );
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
      `message-${index}`,
      room,
      agent,
      secret,
    ]);
    await db.query(
      `INSERT INTO device_update_receipts(identity_id,device_id,receipt) VALUES($1,$2,$3::jsonb)`,
      [
        human,
        `device-${index}`,
        JSON.stringify({
          platform,
          releaseVersion: index <= 6 ? 'v2' : 'v1',
          runtimeVersion: '30',
        }),
      ],
    );
  }
}


export const coreWorkspace = '30000000-0000-4000-8000-000000000802';

export const coreRoom = '30000000-0000-4000-8000-000000000803';

export const secondWorkspace = '30000000-0000-4000-8000-000000000804';

export const coreMeasuredAt = '2026-10-27T16:00:00.000Z';

export const coreId = (n: number) => n.toString(16).padStart(64, '0');

export const coreAt = (day: string, hourUtc = 16) =>
  `${day}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`;


export function easternDay(instant = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

export function shiftEasternDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

export function corePoint<T extends { date: string }>(daily: T[], date: string): T {
  const found = daily.find((row) => String(row.date).slice(0, 10) === date);
  if (!found) throw new Error(`missing ${date}`);
  return found;
}
export const rootFixture = {
get db(){return db;}, set db(value: typeof db){db=value;},
get server(){return server;}, set server(value: typeof server){server=value;},
get base(){return base;}, set base(value: typeof base){base=value;},
};
export function fixtureScope3() {

  const A = 1, B = 2, A1 = 3, A2 = 4, B1 = 5, INTERNAL = 6, BOTH = 7, ANDROID = 8;

  const F = 9, G = 10, H = 11, I = 12, J = 13, K = 14, L = 15, NULL_INVITE = 16;

  const STARTERS = 17, DELETED = 18, ROOM_INVITEE = 19, AGENT_INVITEE = 20;

  const FREE = 30, G_AGENT = 31, H_AGENT = 32, J_AGENT = 33, K_AGENT = 34, L_AGENT = 35;

  const ANDROID_AGENT = 36, INTERNAL_AGENT = 37, ANDROID_FREE = 38;


  async function identity(n: number, kind: 'human' | 'agent', createdAt = '2020-01-01T00:00:00.000Z') {
    await rootFixture.db.query(
      `INSERT INTO identities(id,kind,name,created_at) VALUES($1,$2,$3,$4)`,
      [coreId(n), kind, kind, createdAt],
    );
  }

  async function join(n: number, ws: string, at?: string, invitedBy?: number) {
    await rootFixture.db.query(
      `INSERT INTO memberships(workspace_id,identity_id,role,joined_at,invited_by)
       VALUES($1,$2,'member',COALESCE($3::timestamptz, now()),$4)`,
      [ws, coreId(n), at ?? null, invitedBy === undefined ? null : coreId(invitedBy)],
    );
  }

  async function device(n: number, platform: 'ios' | 'android') {
    await rootFixture.db.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES($1,$2,$3,'physical')`,
      [`core-push-${n}`, coreId(n), platform],
    );
  }

  async function person(n: number, platform: 'ios' | 'android', createdAt?: string, ws = workspace) {
    await identity(n, 'human', createdAt);
    await join(n, ws);
    await device(n, platform);
  }

  async function ownAgent(n: number, owner: number, opts?: { free?: boolean; roomMember?: boolean }) {
    await identity(n, 'agent');
    await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [coreId(n), coreId(owner)]);
    await join(n, workspace);
    if (opts?.roomMember) {
      await rootFixture.db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [workspace, room, coreId(n)],
      );
    }
    if (opts?.free) {
      await rootFixture.db.query(
        `INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys) VALUES($1,$2,$3,'sealed')`,
        [coreId(n), workspace, coreId(owner)],
      );
    }
  }

  async function invite(key: string, personId: number, ws: string, at: string | null, onboarding = false) {
    await rootFixture.db.query(
      `INSERT INTO invites(token_hash,workspace_id,created_by,expires_at,created_at,onboarding_room_id)
       VALUES($1,$2,$3,now() + interval '7 days',$4,$5)`,
      [key, ws, coreId(personId), at, onboarding ? room : null],
    );
  }

  async function pairing(key: string, personId: number, ws: string, at: string | null) {
    await rootFixture.db.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at,created_at)
       VALUES($1,$2,$3,now() + interval '1 day',$4)`,
      [key, ws, coreId(personId), at],
    );
  }

  async function say(key: string, author: number, at: string, roomId = room) {
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'hello',$4)`,
      [key, roomId, coreId(author), at],
    );
  }

  async function repoCard(
    key: string, personId: number, at: string, kind: 'repository' | 'starters', roomId = room, deleted = false,
  ) {
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at,deleted_at)
       VALUES($1,$2,$3,'repository','card','repository-onboarding',$4::jsonb,$5,$6)`,
      [key, roomId, coreId(personId), JSON.stringify({ kind, requesterId: coreId(personId) }), at, deleted ? at : null],
    );
  }
return {
A,
B,
A1,
A2,
B1,
INTERNAL,
BOTH,
ANDROID,
F,
G,
H,
I,
J,
K,
L,
NULL_INVITE,
STARTERS,
DELETED,
ROOM_INVITEE,
AGENT_INVITEE,
FREE,
G_AGENT,
H_AGENT,
J_AGENT,
K_AGENT,
L_AGENT,
ANDROID_AGENT,
INTERNAL_AGENT,
ANDROID_FREE,
identity,
join,
device,
person,
ownAgent,
invite,
pairing,
say,
repoCard,
};
}
export { phoneFetch } from '../../../tests/helpers/phone-operation.js';
export { AddressInfo } from 'node:net';
export { randomUUID } from 'node:crypto';
export { recordSigninFunnelEvent } from './signin-funnel.js';
export { createSigninFunnelClient } from '@beeline/api-contract/signin-funnel-client';
export { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
export { PgliteDatabase, migratedDatabase } from './test-support.js';
export { createBeelineServer } from './server.js';
export { dashboardHealth, dashboardOps } from './operator-dashboard.js';
export { dashboardOverview } from './operator-dashboard-overview.js';
export { REVIEW_IDENTITY_ID } from './review-access.js';
export { QueryWindow } from './query-profile.js';
export { claimAgentCommand, createAgentCommand } from './agent-command.js';
export { DaemonService } from './daemon-service.js';
export { LiveHub } from './live.js';
export { dashboardCoreMetrics } from './operator-dashboard-core-metrics.js';
export type { SqlDatabase } from './database.js';
export type { TokenAuth } from './auth.js';
export type { PhoneService } from './phone-service.js';
