import { phoneFetch } from '../../../tests/helpers/phone-operation.js';

import { ensureSystemDirectMessageRoom } from './system-line.js';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import { createHash, type randomUUID } from 'node:crypto';

import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from './database.js';

import { PgliteDatabase, migratedDatabase } from './test-support.js';

import { TokenAuth } from './auth.js';

import { companyPopularity } from './workbench-companies.js';

import { PhoneService } from './phone-service.js';

import { DaemonService } from './daemon-service.js';

import { LiveHub } from './live.js';

import { createBeelineServer } from './server.js';

import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

import { GitHubOperations } from './github-operations.js';

import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';

import {
  applyVaultList,
} from './workbench.js';


export const HUMAN = createHash('sha256').update('github:owner').digest('hex');

export const RECIPIENT = createHash('sha256').update('github:recipient').digest('hex');

export const HELPER = 'b'.repeat(64);

export const OTHER_HELPER = 'c'.repeat(64);

export const WORKSPACE = '11111111-1111-4111-8111-111111111111';
export function fixtureScope1() {

  let database: PgliteDatabase;

  let auth: TokenAuth;

  let origin: string;

  let server: ReturnType<typeof createBeelineServer>;

  let accessToken: string;

  let recipientToken: string;

  let helperToken: string;

  let otherHelperToken: string;

  let phone: PhoneService;

  let daemon: DaemonService;


  beforeEach(async () => {
    database = await migratedDatabase();
    await new AuthStore(database as unknown as TransactionalDatabase).migrate();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject)
       VALUES($1,'human','Owner','owner','owner'),($2,'agent','Bee','bee',NULL),
             ($3,'human','Recipient','recipient','recipient'),($4,'agent','Wasp','wasp',NULL)`,
      [HUMAN, HELPER, RECIPIENT, OTHER_HELPER],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2),($3,$4)`, [
      HELPER,
      HUMAN,
      OTHER_HELPER,
      RECIPIENT,
    ]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),($1,NULL,$5,'member')`,
      [WORKSPACE, HUMAN, RECIPIENT, HELPER, OTHER_HELPER],
    );
    auth = new TokenAuth(database, async (proof) => {
      const login = proof === 'proof' ? 'owner' : proof === 'recipient-proof' ? 'recipient' : proof;
      return { subject: login, login, name: login[0]!.toUpperCase() + login.slice(1) };
    });
    const githubOperations = new GitHubOperations(
      database,
      {} as unknown as GitHubOAuthClient,
      {} as unknown as GitHubAppClient,
      'github-client-secret',
    );
    phone = new PhoneService(
      database,
      'http://placeholder',
      githubOperations,
      undefined,
      undefined,
      false,
      database,
      undefined,
      undefined,
    );
    const live = new LiveHub();
    daemon = new DaemonService(
      database,
      live,
      undefined,
      undefined,
      false,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
    );
    server = createBeelineServer({ database, auth, phone, daemon, live });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    accessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
    recipientToken = (await auth.exchangeGitHubOidc('recipient-proof')).accessToken;
    helperToken = (await auth.exchangeDaemonToken(
      (await auth.createDaemonExchange(HELPER)).exchangeToken,
    ))!.daemonToken;
    otherHelperToken = (await auth.exchangeDaemonToken(
      (await auth.createDaemonExchange(OTHER_HELPER)).exchangeToken,
    ))!.daemonToken;
  });


  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (database) await database.close();
  });


  const operation = (name: string, payload: unknown, token = accessToken) =>
    phoneFetch(`${origin}/v1/phone/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

  const phoneOperation = async (name: string, payload: unknown, token = accessToken) => {
    const response = await operation(name, payload, token);
    expect([200, 204]).toContain(response.status);
    return response.status === 204 ? undefined : ((await response.json()) as unknown);
  };

  const daemonOperation = async (name: string, payload: unknown, token = helperToken) => {
    const response = await phoneFetch(`${origin}/v1/daemon/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };


  async function connectionReceiptCards() {
    return (
      await database.query<{ author_id: string; text: string; card_type: string }>(
        `SELECT m.author_id,m.text,m.card_type FROM messages m
         JOIN rooms r ON r.id=m.room_id
         WHERE r.workspace_id=$1 AND r.parent_id IS NULL AND m.card_type='connection-receipt'`,
        [WORKSPACE],
      )
    ).rows;
  }


  async function pairOwnerConnector(connectorType = 'trusty-squire') {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType,
      helperAgentId: HELPER,
    })) as { connectorId: string; status: { status: string } };
    expect(paired.status.status).toBe('installing');
    // The mock helper claims the install, then reports its vault. The vault
    // report path (applyVaultList) is the server's ingest for the helper's
    // future sync report; grants ride the helper's detail surface, so one
    // live grant is seeded here in the shape the helper reports.
    await daemonOperation('installConnector', { connectorId: paired.connectorId });
    const machine = (await database.query<{ machine_id: string }>(
      'SELECT COALESCE(machine_id,agent_id) machine_id FROM agents WHERE agent_id=$1', [HELPER])).rows[0]!;
    const vaultTarget = connectorType === 'trusty-squire'
      ? { machine_id: machine.machine_id, workspace_id: WORKSPACE, owner_identity_id: HUMAN }
      : { id: paired.connectorId, owner_identity_id: HUMAN };
    if (connectorType === 'trusty-squire') await daemonOperation('postConnectorVault', { connections: [] });
    await applyVaultList(database, vaultTarget, [
      {
        reference: 'github.com/acme/tooling',
        service: 'github',
        label: 'Acme tooling',
        fieldNames: ['token'],
        allowedHosts: ['github.com'],
        createdAt: Math.floor(Date.now() / 1000),
        stale: false,
        state: 'active',
      },
    ]);
    await database.query(
      `UPDATE workspace_connections SET grants=$2::jsonb WHERE COALESCE(connector_id::text,'squire:' || machine_id)=$1`,
      [
        paired.connectorId,
        JSON.stringify([
          {
            grantId: 'hoots',
            credentialRef: 'github.com/acme/tooling',
            createdAt: Math.floor(Date.now() / 1000),
          },
        ]),
      ],
    );
    return paired.connectorId;
  }
return {
get database(){return database;}, set database(value: typeof database){database=value;},
get auth(){return auth;}, set auth(value: typeof auth){auth=value;},
get origin(){return origin;}, set origin(value: typeof origin){origin=value;},
get server(){return server;}, set server(value: typeof server){server=value;},
get accessToken(){return accessToken;}, set accessToken(value: typeof accessToken){accessToken=value;},
get recipientToken(){return recipientToken;}, set recipientToken(value: typeof recipientToken){recipientToken=value;},
get helperToken(){return helperToken;}, set helperToken(value: typeof helperToken){helperToken=value;},
get otherHelperToken(){return otherHelperToken;}, set otherHelperToken(value: typeof otherHelperToken){otherHelperToken=value;},
get phone(){return phone;}, set phone(value: typeof phone){phone=value;},
get daemon(){return daemon;}, set daemon(value: typeof daemon){daemon=value;},
operation,
phoneOperation,
daemonOperation,
connectionReceiptCards,
pairOwnerConnector,
};
}
export { phoneFetch } from '../../../tests/helpers/phone-operation.js';
export { ensureSystemDirectMessageRoom } from './system-line.js';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export { createHash, randomUUID } from 'node:crypto';
export { AddressInfo } from 'node:net';
export { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
export { migrate } from './database.js';
export { PgliteDatabase, migratedDatabase } from './test-support.js';
export { TokenAuth } from './auth.js';
export { companyPopularity } from './workbench-companies.js';
export { PhoneService } from './phone-service.js';
export { DaemonService } from './daemon-service.js';
export { LiveHub } from './live.js';
export { createBeelineServer } from './server.js';
export { GitHubOperations } from './github-operations.js';
export { AuthStore } from '@beeline/auth/store';
export { applyVaultList } from './workbench.js';
export type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
export type { TransactionalDatabase } from '@beeline/auth/store';
