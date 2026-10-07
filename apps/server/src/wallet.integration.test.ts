import { createAgentCommand, claimAgentCommand } from './agent-command.js';
import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { GitHubOperations } from './github-operations.js';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import { walletSource } from './wallet.js';
import { connectorIdentityId } from './workbench.js';
import type { FakeWalletState } from './cdp-fake.js';

const HUMAN = createHash('sha256').update('github:owner').digest('hex');
const HELPER = 'b'.repeat(64);
const ROOM = '22222222-2222-4222-8222-222222222222';
const WALLET_REQUEST = 'e'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

/**
 * The wallet runs on the FAKE CDP source (never a real key) through the same
 * phone/daemon operation surfaces the mobile app and the MCP tools use.
 */
const BRIDGE2 = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';

describe('wallet over the fake CDP seam', () => {
  let database: PgliteDatabase;
  let auth: TokenAuth;
  let origin: string;
  let server: ReturnType<typeof createBeelineServer>;
  let accessToken: string;
  let helperToken: string;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
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
    server = createBeelineServer({ database, auth, phone, daemon, live });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    accessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
    helperToken = (await auth.exchangeDaemonToken(
      (await auth.createDaemonExchange(HELPER)).exchangeToken,
    ))!.daemonToken;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (database) await database.close();
  });

  const phoneOperation = async (name: string, payload: unknown) => {
    const response = await fetch(`${origin}/v1/phone/operations/${name}`, {
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
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
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

  type CdpWalletSourceLike = { readonly state?: unknown };

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

  it('wallet-503: owned agent reads resolve its wallet and Workbench follows signing delegation', async () => {
    const wallet = await createdWallet();
    const readCatalog = async () => (await daemonOperation('readAgentWorkbench', {})).body.catalog as Array<{ connectorType: string; paired?: { status: string } }>;
    expect((await readCatalog()).find((entry) => entry.connectorType === 'wallet')?.paired).toBeUndefined();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    for (const name of ['getWalletToolState', 'getWalletToolChains', 'getWalletToolBalance']) {
      const result = await daemonOperation(name, { agentId: HELPER });
      expect(result.status).toBe(200);
      if (name === 'getWalletToolState') expect(result.body.wallet).toMatchObject({ address: wallet.address });
    }
    expect((await readCatalog()).find((entry) => entry.connectorType === 'wallet')?.paired).toMatchObject({ status: 'connected', onThisMachine: true });
    for (const agentId of ['self', 'f'.repeat(64)]) {
      const result = await daemonOperation('getWalletToolState', { agentId });
      expect(result.status).toBe(503);
      expect(result.body.error).toBe('daemon token does not own requested agent');
    }
    await database.query(`UPDATE wallet_bindings SET delegation_standing=false,delegation_expires_at=NULL WHERE identity_id=$1`, [HUMAN]);
    expect((await readCatalog()).find((entry) => entry.connectorType === 'wallet')?.paired).toBeUndefined();
  });

  it('signs harmless Exchange chainId 1337 data only with live delegation and records a signature audit', async () => {
    const wallet = await createdWallet();
    const source = walletSource();
    const sign = vi.spyOn(source, 'signTypedData');
    const input = { agentId: HELPER, ...harmlessTypedData };
    expect((await daemonOperation('walletSignTypedData', input)).body.outcome).toBe('delegation-expired');
    expect(sign).not.toHaveBeenCalled();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const result = await daemonOperation('walletSignTypedData', input);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: 'signed', signature: expect.stringMatching(/^0x[a-f0-9]{130}$/) });
    expect(sign).toHaveBeenCalledWith(wallet.address, harmlessTypedData);
    const audit = (await database.query<{ card: Record<string, unknown>; text: string }>(
      `SELECT card,text FROM messages WHERE card_type='wallet-signature'`,
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.card).toMatchObject({ agentId: HELPER, address: wallet.address, domain: harmlessTypedData.domain, primaryType: 'BeelineTest', payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(audit[0]!.card).not.toHaveProperty('signature');
    expect(audit[0]!.text).toContain('signed EIP-712 typed data');
    expect((await database.query('SELECT id FROM wallet_transactions')).rows).toHaveLength(0);
    expect((await daemonOperation('getWalletToolBalance', { agentId: HELPER })).body.totalUsd).toBe('$0.00');
    await database.query(`UPDATE wallet_bindings SET delegation_standing=false,delegation_expires_at=NULL WHERE identity_id=$1`, [HUMAN]);
    expect((await daemonOperation('walletSignTypedData', input)).body.outcome).toBe('delegation-expired');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('holds typed-data signing for third-party requesters, consumes once approval and rejects foreign agents', async () => {
    await createdWallet();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const requester = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Requester')`, [requester]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WORKSPACE, requester, ROOM]);
    await database.query(`UPDATE messages SET author_id=$2 WHERE id=$1`, [WALLET_REQUEST, requester]);
    const sign = vi.spyOn(walletSource(), 'signTypedData');
    const input = { agentId: HELPER, ...harmlessTypedData };
    const pending = await daemonOperation('walletSignTypedData', input);
    expect(pending.body.status).toBe('permission-required');
    expect(sign).not.toHaveBeenCalled();
    const grant = (await database.query<{ command_id: string; requested_by: string }>(`SELECT command_id,requested_by FROM agent_grants WHERE id=$1`, [pending.body.grantId])).rows[0]!;
    expect(grant.command_id).toBeTruthy();
    expect(grant.requested_by).toBe(requester);
    await phoneOperation('decideAgentGrant', { grantId: pending.body.grantId, decision: 'once' });
    expect((await daemonOperation('walletSignTypedData', input)).body.outcome).toBe('signed');
    expect((await daemonOperation('walletSignTypedData', input)).body.status).toBe('permission-required');
    expect((await daemonOperation('walletSignTypedData', { ...input, agentId: 'f'.repeat(64) })).status).toBe(503);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed typed data and reports provider refusals without recording success', async () => {
    await createdWallet();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const sign = vi.spyOn(walletSource(), 'signTypedData').mockRejectedValue(new Error('CDP policy refused chainId 1337'));
    for (const bad of [{ domain: null }, { types: [] }, { message: [] }, { primaryType: 'Missing' }, { types: { BeelineTest: [{}] } }]) {
      expect((await daemonOperation('walletSignTypedData', { agentId: HELPER, ...harmlessTypedData, ...bad })).body).toMatchObject({ outcome: 'failed', reason: 'invalid EIP-712 typed data' });
    }
    expect(sign).not.toHaveBeenCalled();
    for (const roomInput of [{}, { roomId: ROOM }]) {
      const response = await fetch(`${origin}/v1/daemon/operations/walletSignTypedData`, {
        method: 'POST', headers: { authorization: `Bearer ${helperToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: HELPER, ...harmlessTypedData, ...roomInput }),
      });
      expect(response.ok).toBe(false);
    }
    expect(sign).not.toHaveBeenCalled();
    expect((await daemonOperation('walletSignTypedData', { agentId: HELPER, ...harmlessTypedData })).body).toEqual({ outcome: 'failed', reason: 'CDP policy refused chainId 1337' });
    expect((await database.query(`SELECT id FROM messages WHERE card_type='wallet-signature'`)).rows).toHaveLength(0);
  });

  it('one tap creates the wallet bound to the signed-in identity', async () => {
    const view = await createdWallet();
    expect(view.address).toMatch(/^0x/);
    const again = (await phoneOperation('createWallet', { workspaceId: WORKSPACE })) as {
      address: string;
    };
    expect(again.address).toBe(view.address);

    const emptyChats = (await (
      await fetch(`${origin}/v1/phone/workspaces/${WORKSPACE}/chats`, {
        headers: { authorization: `Bearer ${accessToken}` },
      })
    ).json()) as { chats: Array<{ directMessage?: { peer: { handle?: string } } }> };
    expect(emptyChats.chats.some((chat) => chat.directMessage?.peer.handle === 'wallet')).toBe(
      false,
    );

    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE, ttlHours: 24 });
    const chats = (await (
      await fetch(`${origin}/v1/phone/workspaces/${WORKSPACE}/chats`, {
        headers: { authorization: `Bearer ${accessToken}` },
      })
    ).json()) as {
      chats: Array<{
        latestMessage?: { text: string };
        directMessage?: { peer: { name: string; handle?: string; avatar?: string } };
      }>;
    };
    const wallet = chats.chats.find((chat) => chat.directMessage?.peer.handle === 'wallet');
    expect(wallet?.directMessage?.peer).toMatchObject({
      name: 'Wallet',
      handle: 'wallet',
      avatar: 'http://placeholder/v1/connectors/logo/wallet.svg',
    });
    expect(wallet?.latestMessage?.text).toContain('granted agents permission to sign');
  });

  it('rejects missing, malformed, and inaccessible grant Workspaces before changing expiry', async () => {
    await createdWallet();
    await database.query(
      `UPDATE wallet_bindings SET delegation_expires_at=now() - interval '1 hour' WHERE identity_id=$1`,
      [HUMAN],
    );
    expect(
      (
        (await phoneOperation('readWallet', { workspaceId: '' })) as {
          delegation: { active: boolean };
        }
      ).delegation.active,
    ).toBe(false);
    const otherWorkspace = '33333333-3333-4333-8333-333333333333';
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other')`, [otherWorkspace]);
    for (const [payload, expected] of [
      [{}, 'valid Workspace ID required'],
      [{ workspaceId: '' }, 'valid Workspace ID required'],
      [{ workspaceId: 'not-a-uuid' }, 'valid Workspace ID required'],
      [{ workspaceId: otherWorkspace }, 'workspace membership required'],
    ] as const) {
      const response = await fetch(`${origin}/v1/phone/operations/grantWalletDelegation`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(expected);
      const expiry = (
        await database.query<{ active: boolean }>(
          `SELECT delegation_expires_at > now() AS active FROM wallet_bindings WHERE identity_id=$1`,
          [HUMAN],
        )
      ).rows[0];
      expect(expiry?.active).toBe(false);
    }
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    expect(
      (
        (await phoneOperation('readWallet', { workspaceId: '' })) as {
          delegation: { active: boolean };
        }
      ).delegation.active,
    ).toBe(true);
    const expiry = (
      await database.query<{ active: boolean; expires_at: Date | null }>(
        `SELECT delegation_standing AS active,delegation_expires_at AS expires_at FROM wallet_bindings WHERE identity_id=$1`,
        [HUMAN],
      )
    ).rows[0];
    expect(expiry?.active).toBe(true);
    expect(expiry?.expires_at).toBeNull();
  });

  it('distinguishes never granted, legacy timed, expired, standing, and revoked states', async () => {
    await createdWallet();
    const read = async () =>
      (await phoneOperation('readWallet', { workspaceId: WORKSPACE })) as {
        delegation: { active: boolean; expiresAt: number | null };
      };
    expect((await read()).delegation).toEqual({ active: false, expiresAt: null });

    const legacyExpiry = new Date(Date.now() + 3_600_000);
    await database.query(
      `UPDATE wallet_bindings SET delegation_expires_at=$2 WHERE identity_id=$1`,
      [HUMAN, legacyExpiry],
    );
    expect((await read()).delegation).toEqual({ active: true, expiresAt: legacyExpiry.getTime() });
    await database.query(
      `UPDATE wallet_bindings SET delegation_expires_at=now() - interval '1 hour' WHERE identity_id=$1`,
      [HUMAN],
    );
    expect((await read()).delegation.active).toBe(false);

    expect(await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE })).toEqual({
      expiresAt: null,
    });
    expect((await read()).delegation).toEqual({ active: true, expiresAt: null });
    const grantCard = (
      await database.query<{ text: string; card: { standing: boolean } }>(
        `SELECT text,card FROM messages WHERE card_type='wallet-delegation' ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows[0];
    expect(grantCard?.text).toContain('until revoked');
    expect(grantCard?.card).toEqual({ standing: true });
    const workbench = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      wallet: { delegationActive: boolean; delegationExpiresAt: number | null };
    };
    expect(workbench.wallet).toMatchObject({ delegationActive: true, delegationExpiresAt: null });
    await database.query(
      `UPDATE wallet_bindings SET delegation_standing=false WHERE identity_id=$1`,
      [HUMAN],
    );
    expect((await read()).delegation).toEqual({ active: false, expiresAt: null });
    expect(
      (
        (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
          wallet: { delegationActive: boolean };
        }
      ).wallet.delegationActive,
    ).toBe(false);
    expect(
      (
        await daemonOperation('walletPay', {
          agentId: HELPER,
          chain: 'base',
          asset: 'usdc',
          amount: '1',
          to: '0xabc',
        })
      ).body.outcome,
    ).toBe('delegation-expired');
  });

  it('a wallet offer card connects the wallet when its addressee accepts', async () => {
    const offered = await daemonOperation('offerConnector', {
      connectorType: 'wallet',
      reason: 'pay the hosting invoice',
    });
    expect(offered.status).toBe(200);
    const offerId = offered.body.offerId as string;
    const pending = await database.query<{ card: Record<string, any> }>(
      `SELECT card FROM messages WHERE card_type='connector-offer'`,
    );
    expect(pending.rows[0]!.card).toMatchObject({
      offerId,
      connectorType: 'wallet',
      status: 'pending',
      consequence:
        'This changes your Workbench. Once it is added, I can pay the hosting invoice — you can revoke permission any time',
    });

    // A Workspace admin who is not the addressee cannot grant someone else's wallet.
    const adminToken = (await auth.exchangeGitHubOidc('mara')).accessToken;
    const admin = (
      await database.query<{ id: string }>(`SELECT id FROM identities WHERE github_subject='mara'`)
    ).rows[0]!;
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'admin')`,
      [WORKSPACE, admin.id],
    );
    const refused = await fetch(`${origin}/v1/phone/operations/acceptConnectorOffer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ offerId }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'Only the person the agent addressed can connect their own wallet',
    });
    expect(
      (await database.query(`SELECT 1 FROM wallet_bindings WHERE identity_id=$1`, [HUMAN]))
        .rowCount,
    ).toBe(0);

    // The addressee accepts: that tap creates the wallet and grants agents
    // permission to sign, and the card settles without a helper ceremony.
    expect(await phoneOperation('acceptConnectorOffer', { offerId })).toEqual({
      offerId,
      status: 'accepted',
      roomId: ROOM,
    });
    const binding = await database.query<{ delegation_standing: boolean }>(
      `SELECT delegation_standing FROM wallet_bindings WHERE identity_id=$1`,
      [HUMAN],
    );
    expect(binding.rows[0]?.delegation_standing).toBe(true);
    const settled = await database.query<{ card: Record<string, any> }>(
      `SELECT card FROM messages WHERE card_type='connector-offer'`,
    );
    expect(settled.rows[0]!.card).toMatchObject({ status: 'accepted', acceptedAt: expect.any(Number) });
    expect(settled.rows[0]!.card.acceptedBy.pubkey).toBe(HUMAN);
    const decision = await database.query<{ card: Record<string, any> }>(
      `SELECT card FROM messages WHERE card_type='connector-offer-decision'`,
    );
    expect(decision.rows.map((row) => row.card)).toEqual([{ offerId, status: 'accepted' }]);

    // A connected wallet is not offered again.
    const again = await daemonOperation('offerConnector', {
      connectorType: 'wallet',
      reason: 'pay the hosting invoice',
    });
    expect(again.status).toBe(409);
  });

  it('a failing history read does not break createWallet or readWallet', async () => {
    // The real CDP v2 history endpoint is unconfirmed (it 401s/404s); the
    // wallet must be fully usable — address + balances — regardless.
    const source = walletSource() as CdpWalletSourceLike & {
      history: (address: string, limit: number) => Promise<never>;
    };
    const originalHistory = source.history.bind(source);
    source.history = () => Promise.reject(new Error('CDP GET .../transfers failed (401)'));
    try {
      const view = (await phoneOperation('createWallet', { workspaceId: WORKSPACE })) as {
        address: string;
        totalUsd: string;
      };
      expect(view.address).toMatch(/^0x/);
      const read = (await phoneOperation('readWallet', { workspaceId: WORKSPACE })) as {
        address: string;
        totalUsd: string;
      };
      expect(read.address).toBe(view.address);
      expect(typeof read.totalUsd).toBe('string');
    } finally {
      source.history = originalHistory;
    }
  });

  it('holds third-party paid calls for the wallet owner and sends only after scoped approval', async () => {
    await createdWallet();
    fakeState().holdings.forEach((holdings) => holdings.set('usdc', 500));
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE, ttlHours: 24 });
    const requester = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Requester')`, [
      requester,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, requester, ROOM],
    );
    await database.query(`UPDATE messages SET author_id=$2 WHERE id=$1`, [
      WALLET_REQUEST,
      requester,
    ]);
    const payment = { agentId: HELPER, chain: 'base', asset: 'usdc', amount: '120', to: '0xabc' };
    const before = (await phoneOperation('readWallet', { workspaceId: WORKSPACE })) as {
      totalUsd: string;
    };
    const pending = await daemonOperation('walletPay', payment);
    expect(pending.body.status).toBe('permission-required');
    const unchanged = (await phoneOperation('readWallet', { workspaceId: WORKSPACE })) as {
      totalUsd: string;
    };
    expect(unchanged.totalUsd).toBe(before.totalUsd);
    const grant = (
      await database.query<{ requested_by: string; command_id: string }>(
        `SELECT requested_by,command_id FROM agent_grants WHERE id=$1`,
        [pending.body.grantId],
      )
    ).rows[0]!;
    expect(grant.requested_by).toBe(requester);
    expect(grant.command_id).toBeTruthy();
    await phoneOperation('decideAgentGrant', { grantId: pending.body.grantId, decision: 'once' });
    expect((await daemonOperation('walletPay', payment)).body.outcome).toBe('sent');
    expect((await daemonOperation('walletPay', payment)).body.status).toBe('permission-required');
    expect((await database.query(`SELECT id FROM agent_grants WHERE kind='budget'`)).rows).toEqual(
      [],
    );
  });

  it('an agent pay is refused without a live delegation, then lands and posts one ledger card', async () => {
    const view = await createdWallet();
    // Fund the fake: 500 USDC.
    fakeState().holdings.forEach((holdings) => holdings.set('usdc', 500));

    const refused = (await daemonOperation('walletPay', {
      agentId: HELPER,
      chain: 'base',
      asset: 'usdc',
      amount: '120',
      to: '0xabc',
    })) as { body: { outcome: string } };
    expect(refused.body.outcome).toBe('delegation-expired');

    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE, ttlHours: 24 });

    const sent = (await daemonOperation('walletPay', {
      agentId: HELPER,
      chain: 'base',
      asset: 'usdc',
      amount: '120',
      to: '0xabc',
    })) as { body: { outcome: string; balanceAfterUsd: string } };
    expect(sent.body.outcome).toBe('sent');

    const after = (await phoneOperation('readWallet', { workspaceId: WORKSPACE })) as {
      totalUsd: string;
    };
    expect(after.totalUsd).toBe(view.totalUsd === '$0.00' ? '$380.00' : after.totalUsd);
  });

  it('a grant still authorizes agent send and swap after 24 hours', async () => {
    await createdWallet();
    fakeState().holdings.forEach((holdings) => holdings.set('usdc', 500));
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const grantedAt = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(grantedAt + 25 * 3_600_000);

    const pay = await daemonOperation('walletPay', {
      agentId: HELPER,
      chain: 'base',
      asset: 'usdc',
      amount: '10',
      to: '0xabc',
    });
    expect(pay.body.outcome).toBe('sent');

    const swap = await daemonOperation('walletSwap', {
      agentId: HELPER,
      chain: 'base',
      fromAsset: 'usdc',
      toAsset: 'eth',
      amount: '10',
    });
    expect(swap.body.outcome).toBe('sent');
  });

  it('every @wallet DM line is authored by the wallet connector identity, never the agent', async () => {
    await createdWallet();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE, ttlHours: 24 });
    fakeState().holdings.forEach((holdings) => holdings.set('usdc', 500));
    await daemonOperation('walletPay', {
      agentId: HELPER,
      chain: 'base',
      asset: 'usdc',
      amount: '120',
      to: '0xabc',
    });

    // The wallet connector identity is a hidden `kind='human'` row.
    const identity = (
      await database.query<{ kind: string; hidden_from_roster: boolean }>(
        `SELECT kind,hidden_from_roster FROM identities WHERE id=$1`,
        [connectorIdentityId('wallet')],
      )
    ).rows[0];
    expect(identity).toMatchObject({ kind: 'human', hidden_from_roster: true });

    // The wallet DM exists and EVERY line in it comes from @wallet itself —
    // the same receipt-ledger shape the Trusty Squire DM holds.
    const dm = (
      await database.query<{ room_id: string }>(
        `SELECT r.id room_id FROM rooms r
         WHERE r.direct_participants @> to_jsonb(ARRAY[$1::text])`,
        [connectorIdentityId('wallet')],
      )
    ).rows;
    expect(dm).toHaveLength(1);
    const lines = (
      await database.query<{ author_id: string; card_type: string | null }>(
        `SELECT author_id,card_type FROM messages WHERE room_id=$1 ORDER BY created_at`,
        [dm[0]!.room_id],
      )
    ).rows;
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((line) => line.author_id === connectorIdentityId('wallet'))).toBe(true);
  });

  /** Fund one non-Base chain of the fake wallet. */
  function fundChain(address: string, chain: string, symbol: string, units: number) {
    const key = `${chain}:${address}`;
    const holdings = fakeState().holdings.get(key) ?? new Map<string, number>();
    holdings.set(symbol, units);
    fakeState().holdings.set(key, holdings);
  }

  it('an Arbitrum-only wallet reads its real balance, chains, quote and inbound history', async () => {
    // The fake outlives a test; start from an empty wallet on every chain.
    fakeState().holdings.clear();
    const wallet = await createdWallet();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    fundChain(wallet.address, 'arbitrum', 'eth', 0.5);

    const balance = (await daemonOperation('getWalletToolBalance', { agentId: HELPER })).body;
    expect(balance).toEqual({
      totalUsd: '$1,600.00',
      coins: [{ symbol: 'eth', name: 'ETH', chain: 'arbitrum', amount: '0.50', usd: '$1,600.00' }],
    });
    const chains = (await daemonOperation('getWalletToolChains', { agentId: HELPER })).body
      .chains as Array<{ id: string; hasBalance: boolean }>;
    expect(chains.filter((chain) => chain.hasBalance).map((chain) => chain.id)).toEqual(['arbitrum']);
    expect(
      (await daemonOperation('getWalletToolQuote', { agentId: HELPER, chain: 'arbitrum', asset: 'eth', amount: '0.001' })).body,
    ).toMatchObject({ available: '0.50', sufficient: true, chain: 'arbitrum' });
    expect(
      (await daemonOperation('getWalletToolQuote', { agentId: HELPER, chain: 'base', asset: 'eth', amount: '0.001' })).body,
    ).toMatchObject({ available: '0', sufficient: false, chain: 'base' });

    const history = async () =>
      (await daemonOperation('getWalletToolHistory', { agentId: HELPER })).body.entries as Array<{
        direction: string;
        amountText: string;
        chain: string;
        txUrl: string | null;
      }>;
    const arbitrumInbound = async () =>
      (await history()).filter((entry) => entry.direction === 'in' && entry.chain === 'arbitrum');
    const inbound = await arbitrumInbound();
    expect(inbound).toEqual([
      expect.objectContaining({ amountText: '+0.5 ETH', chain: 'arbitrum', txUrl: null }),
    ]);
    // A repeated read records the same deposit once.
    expect(await arbitrumInbound()).toHaveLength(1);
    fundChain(wallet.address, 'arbitrum', 'eth', 0.75);
    expect((await arbitrumInbound()).map((entry) => entry.amountText)).toEqual([
      '+0.5 ETH',
      '+0.25 ETH',
    ]);
  });

  it('pays and swaps on Arbitrum without reading the swap output as a deposit', async () => {
    // The fake outlives a test; start from an empty wallet on every chain.
    fakeState().holdings.clear();
    const wallet = await createdWallet();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    fundChain(wallet.address, 'arbitrum', 'eth', 1);
    fundChain(wallet.address, 'arbitrum', 'usdc', 50);

    const paid = await daemonOperation('walletPay', {
      agentId: HELPER, chain: 'arbitrum', asset: 'usdc', amount: '20', to: '0xabc',
    });
    expect(paid.body).toMatchObject({ outcome: 'sent', txUrl: expect.stringMatching(/^https:\/\/arbiscan\.io\/tx\//) });
    expect(fakeState().holdings.get(`arbitrum:${wallet.address}`)!.get('usdc')).toBe(30);

    const swapped = await daemonOperation('walletSwap', {
      agentId: HELPER, chain: 'arbitrum', fromAsset: 'eth', toAsset: 'usdc', amount: '0.5',
    });
    expect(swapped.body).toMatchObject({ outcome: 'sent', txUrl: expect.stringMatching(/^https:\/\/arbiscan\.io\/tx\//) });
    const entries = (await daemonOperation('getWalletToolHistory', { agentId: HELPER })).body.entries as Array<{
      direction: string; amountText: string; chain: string;
    }>;
    expect(
      entries
        .filter((entry) => entry.direction === 'in' && entry.chain === 'arbitrum')
        .map((entry) => entry.amountText)
        .sort(),
    ).toEqual([
      '+1 ETH',
      '+50 USDC',
    ]);
    expect(entries.filter((entry) => entry.direction === 'out').every((entry) => entry.chain === 'arbitrum')).toBe(true);
  });

  it('reports an unsupported swap chain as a named failure', async () => {
    await createdWallet();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    vi.spyOn(walletSource(), 'swap').mockRejectedValue(new Error('swap unsupported on zora'));
    expect(
      (await daemonOperation('walletSwap', { agentId: HELPER, chain: 'zora', fromAsset: 'usdc', toAsset: 'eth', amount: '1' })).body,
    ).toEqual({ outcome: 'failed', reason: 'swap unsupported on zora' });
  });

  it('refuses a wallet_pay to Hyperliquid Bridge2 that the venue rule says is lost', async () => {
    // The fake outlives a test; start from an empty wallet on every chain.
    fakeState().holdings.clear();
    const wallet = await createdWallet();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    fundChain(wallet.address, 'arbitrum', 'usdc', 10);
    fundChain(wallet.address, 'arbitrum', 'eth', 1);
    const send = vi.spyOn(walletSource(), 'sendTransaction');
    const pay = (asset: string, amount: string) =>
      daemonOperation('walletPay', { agentId: HELPER, chain: 'arbitrum', asset, amount, to: BRIDGE2 });

    expect((await pay('usdc', '4.99')).body).toEqual({
      outcome: 'failed',
      reason:
        'Hyperliquid Bridge2 deposits must be at least 5 USDC; a smaller deposit is never credited and is lost',
    });
    expect((await pay('eth', '0.1')).body).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('credits only USDC'),
    });
    expect(send).not.toHaveBeenCalled();
    expect((await pay('usdc', '5')).body).toMatchObject({ outcome: 'sent' });
    expect(send).toHaveBeenCalledWith(wallet.address, {
      chain: 'arbitrum',
      asset: 'usdc',
      amount: '5',
      to: BRIDGE2,
    });
  });

  it('approves an exact amount and calls a contract, under the same funds and ledger rules', async () => {
    fakeState().holdings.clear();
    const wallet = await createdWallet();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const call = vi.spyOn(walletSource(), 'contractCall');
    const vault = '0x' + '7'.repeat(40);
    const deposit = { agentId: HELPER, chain: 'arbitrum', contract: vault, data: '0xb6b55f25' + '0'.repeat(64) };

    expect(
      (await daemonOperation('walletContractCall', { ...deposit, approve: { asset: 'usdc', amount: '20' } })).body,
    ).toMatchObject({ outcome: 'insufficient', asset: 'usdc', needed: '20', available: '0' });
    expect(call).not.toHaveBeenCalled();

    fundChain(wallet.address, 'arbitrum', 'usdc', 50);
    const sent = await daemonOperation('walletContractCall', {
      ...deposit,
      approve: { asset: 'usdc', amount: '20' },
    });
    expect(sent.body).toMatchObject({
      outcome: 'sent',
      amountText: '−20 USDC',
      txUrl: expect.stringMatching(/^https:\/\/arbiscan\.io\/tx\//),
    });
    expect(call).toHaveBeenCalledWith(wallet.address, {
      chain: 'arbitrum',
      contract: vault,
      data: deposit.data,
      approve: { asset: 'usdc', amount: '20' },
    });
    const entries = (await daemonOperation('getWalletToolHistory', { agentId: HELPER })).body.entries as Array<{
      direction: string; amountText: string; counterparty: string;
    }>;
    expect(entries.filter((entry) => entry.direction === 'out')).toEqual([
      expect.objectContaining({ amountText: '−20 USDC', counterparty: vault }),
    ]);
  });

  it('refuses contract calls that grant an allowance or break a venue rule', async () => {
    fakeState().holdings.clear();
    const wallet = await createdWallet();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    fundChain(wallet.address, 'arbitrum', 'usdc', 50);
    fundChain(wallet.address, 'arbitrum', 'eth', 1);
    const call = vi.spyOn(walletSource(), 'contractCall');
    const usdc = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const contractCall = (input: Record<string, unknown>) =>
      daemonOperation('walletContractCall', { agentId: HELPER, chain: 'arbitrum', ...input });

    // An unlimited approve hidden in call data.
    expect(
      (await contractCall({ contract: usdc, data: `0x095ea7b3${word('0x' + '7'.repeat(40))}${'f'.repeat(64)}` })).body,
    ).toEqual({
      outcome: 'failed',
      reason: 'call data grants a token allowance; use approve, which approves an exact amount',
    });
    // A USDC transfer to Bridge2 below the minimum, encoded as call data.
    expect(
      (await contractCall({ contract: usdc, data: `0xa9059cbb${word(BRIDGE2)}${word((4_000_000).toString(16))}` })).body,
    ).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('at least 5 USDC') });
    // Native value sent to Bridge2.
    expect((await contractCall({ contract: BRIDGE2, data: '0x', value: '0.1' })).body).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('credits only USDC'),
    });
    expect((await contractCall({ contract: '0x1234', data: '0x' })).body).toMatchObject({ outcome: 'failed' });
    expect(call).not.toHaveBeenCalled();
  });

  it('the only spending refusal is insufficient funds', async () => {
    await createdWallet();
    await phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE, ttlHours: 24 });
    const sent = (await daemonOperation('walletPay', {
      agentId: HELPER,
      chain: 'base',
      asset: 'usdc',
      amount: '999999',
      to: '0xabc',
    })) as { body: { outcome: string; asset: string; available: string } };
    expect(sent.body.outcome).toBe('insufficient');
    expect(sent.body.asset).toBe('usdc');
  });
});
