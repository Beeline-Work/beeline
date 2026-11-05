import { phoneFetch } from '../../../tests/helpers/phone-operation.js';

import { createAgentCommand, claimAgentCommand } from './agent-command.js';

import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';

import { CdpWalletClient, WalletTransactionPending } from './cdp-client.js';

import { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate } from './database.js';

import { PgliteDatabase, migratedDatabase } from './test-support.js';

import { TokenAuth } from './auth.js';

import { PhoneService } from './phone-service.js';

import { DaemonService } from './daemon-service.js';

import { LiveHub } from './live.js';

import { createBeelineServer } from './server.js';

import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

import { GitHubOperations } from './github-operations.js';

import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';

import { walletSource } from './wallet.js';

import { walletExplorerTxUrl } from '@beeline/api-contract/wallet';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import { PushDeliveryLoop } from './background.js';

import { postWalletNotice, type WalletNotice } from './wallet-notices.js';

import type { FakeWalletState } from './cdp-fake.js';


export const HUMAN = createHash('sha256').update('github:owner').digest('hex');

export const HELPER = 'b'.repeat(64);

export const ROOM = '22222222-2222-4222-8222-222222222222';

export const WALLET_REQUEST = 'e'.repeat(64);

export const WORKSPACE = '11111111-1111-4111-8111-111111111111';


/**
 * The wallet runs on the FAKE CDP source (never a real key) through the same
 * phone/daemon operation surfaces the mobile app and the MCP tools use.
 */
export const BRIDGE2 = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';
export type CdpWalletSourceLike = { readonly state?: unknown };
export function fixtureScope1() {

  let database: PgliteDatabase;

  let auth: TokenAuth;

  let origin: string;

  let server: ReturnType<typeof createBeelineServer>;

  let accessToken: string;

  let helperToken: string;


  beforeEach(async () => {
    database = await migratedDatabase();
    await new AuthStore(database as unknown as TransactionalDatabase).migrate();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject)
       VALUES($1,'human','Owner','owner','owner'),($2,'agent','Bee','bee',NULL)`,
      [HUMAN, HELPER],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [HELPER, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
      [WORKSPACE, HUMAN, HELPER],
    );
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Wallet tests')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`,
      [WORKSPACE, ROOM, HUMAN, HELPER],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'use my wallet')`,
      [WALLET_REQUEST, ROOM, HUMAN],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: HELPER,
      sourceMessageId: WALLET_REQUEST,
      reason: 'human_mention',
    });
    await claimAgentCommand(database, ROOM, HELPER, command!.id, 'wallet-generation');
    auth = new TokenAuth(database, async (proof) => {
      const login = proof === 'proof' ? 'owner' : proof;
      return { subject: login, login, name: login };
    });
    const githubOperations = new GitHubOperations(
      database,
      {} as unknown as GitHubOAuthClient,
      {} as unknown as GitHubAppClient,
      'github-client-secret',
    );
    const phone = new PhoneService(database, 'http://placeholder', githubOperations);
    const live = new LiveHub();
    const daemon = new DaemonService(database, live);
    server = createBeelineServer({ database, auth, phone, daemon, live, cdpWebhookSecrets: { test: 'fixture-only-webhook-secret' } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    accessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
    helperToken = (await auth.exchangeDaemonToken(
      (await auth.createDaemonExchange(HELPER)).exchangeToken,
    ))!.daemonToken;
  });


  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (database) await database.close();
  });


  const phoneOperation = async (name: string, payload: unknown) => {
    const response = await phoneFetch(`${origin}/v1/phone/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect([200, 204]).toContain(response.status);
    return response.status === 204 ? undefined : ((await response.json()) as unknown);
  };


  const daemonOperation = async (name: string, payload: unknown) => {
    const pending = (
      await database.query<{ id: string }>(
        `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 ORDER BY created_at DESC LIMIT 1`,
        [ROOM, HELPER, WALLET_REQUEST],
      )
    ).rows[0];
    if (pending) await claimAgentCommand(database, ROOM, HELPER, pending.id, 'wallet-generation');
    const response = await phoneFetch(`${origin}/v1/daemon/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${helperToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(payload as object),
        roomId: ROOM,
        requestId: WALLET_REQUEST,
        generationId: 'wallet-generation',
      }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };


  function fakeState(): FakeWalletState {
    const source = walletSource() as CdpWalletSourceLike;
    expect('state' in source).toBe(true);
    return (source as unknown as { state: FakeWalletState }).state;
  }


  async function createdWallet() {
    const view = (await phoneOperation('createWallet', { workspaceId: WORKSPACE })) as {
      address: string;
      totalUsd: string;
    };
    return view;
  }


  const harmlessTypedData = {
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: `0x${'0'.repeat(40)}` },
    types: { BeelineTest: [{ name: 'notice', type: 'string' }] },
    primaryType: 'BeelineTest', message: { notice: 'Harmless test; no order or transfer' },
  };


  async function notices() {
    return (await database.query<{
      id: string; author_id: string; room_id: string; text: string; card: WalletNotice;
      presentation: string; card_type: string | null; direct_participants: string[];
    }>(`SELECT message.*,room.direct_participants FROM messages message
      JOIN rooms room ON room.id=message.room_id
      WHERE message.card->>'walletNotice'='true' ORDER BY message.created_at,message.id`)).rows;
  }


  async function deliverWalletEvent(type: string, data: Record<string, unknown>, eventId = 'fixture-event') {
    const raw = JSON.stringify({ id: eventId, type, data });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const names = 'content-type x-event-id x-event-type';
    const signature = createHmac('sha256', 'fixture-only-webhook-secret')
      .update(`${timestamp}.${names}.application/json.${eventId}.${type}.${raw}`).digest('hex');
    return phoneFetch(`${origin}/v1/wallet/events/cdp/test`, {
      method: 'POST', body: raw, headers: {
        'content-type': 'application/json', 'x-event-id': eventId, 'x-event-type': type,
        'x-hook0-signature': `t=${timestamp},h=${names},v1=${signature}`,
      },
    });
  }


  /** Fund one non-Base chain of the fake wallet. */
  function fundChain(address: string, chain: string, symbol: string, units: number) {
    const key = chain === 'base' ? address : `${chain}:${address}`;
    const holdings = fakeState().holdings.get(key) ?? new Map<string, number>();
    holdings.set(symbol, units);
    fakeState().holdings.set(key, holdings);
  }
return {
get database(){return database;}, set database(value: typeof database){database=value;},
get auth(){return auth;}, set auth(value: typeof auth){auth=value;},
get origin(){return origin;}, set origin(value: typeof origin){origin=value;},
get server(){return server;}, set server(value: typeof server){server=value;},
get accessToken(){return accessToken;}, set accessToken(value: typeof accessToken){accessToken=value;},
get helperToken(){return helperToken;}, set helperToken(value: typeof helperToken){helperToken=value;},
phoneOperation,
daemonOperation,
fakeState,
createdWallet,
harmlessTypedData,
notices,
deliverWalletEvent,
fundChain,
};
}
export { phoneFetch } from '../../../tests/helpers/phone-operation.js';
export { createAgentCommand, claimAgentCommand } from './agent-command.js';
export { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
export { CdpWalletClient, WalletTransactionPending } from './cdp-client.js';
export { AddressInfo } from 'node:net';
export { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
export { migrate } from './database.js';
export { PgliteDatabase, migratedDatabase } from './test-support.js';
export { TokenAuth } from './auth.js';
export { PhoneService } from './phone-service.js';
export { DaemonService } from './daemon-service.js';
export { LiveHub } from './live.js';
export { createBeelineServer } from './server.js';
export { GitHubOperations } from './github-operations.js';
export { AuthStore } from '@beeline/auth/store';
export { walletSource } from './wallet.js';
export { walletExplorerTxUrl } from '@beeline/api-contract/wallet';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export { PushDeliveryLoop } from './background.js';
export { postWalletNotice } from './wallet-notices.js';
export type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
export type { TransactionalDatabase } from '@beeline/auth/store';
export type { WalletNotice } from './wallet-notices.js';
export type { FakeWalletState } from './cdp-fake.js';
