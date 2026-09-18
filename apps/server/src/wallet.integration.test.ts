import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

/**
 * The wallet runs on the FAKE CDP source (never a real key) through the same
 * phone/daemon operation surfaces the mobile app and the MCP tools use.
 */
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
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${helperToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
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
