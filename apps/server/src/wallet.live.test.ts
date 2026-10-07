/**
 * One live, read-only check against mainnet (no funds move): the agent
 * wallet_balance / wallet_quote / wallet_chains path for the owner wallet in
 * the 2026-10-07 report, through the real CDP client and the public RPCs.
 * The CDP key is a throwaway, so Base and Ethereum fall back to the RPC.
 *
 *   BEELINE_LIVE_WALLET_CHECK=1 npx vitest run src/wallet.live.test.ts
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { agentWalletTool } from './wallet.js';

const ADDRESS = '0xE196B6eD2f276A5c33a122562F13d9a199d89a23';
const OWNER = createHash('sha256').update('live-owner').digest('hex');
const AGENT = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

describe.skipIf(!process.env.BEELINE_LIVE_WALLET_CHECK)('live Arbitrum balance (read-only)', () => {
  let database: PgliteDatabase;

  beforeAll(async () => {
    const pkcs8 = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    vi.stubEnv('COINBASE_CDP_API_KEY_ID', 'live-check-throwaway');
    vi.stubEnv('COINBASE_CDP_API_KEY_SECRET', pkcs8.subarray(pkcs8.length - 32).toString('base64'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
      [OWNER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
      [WORKSPACE, OWNER, AGENT],
    );
    await database.query(
      `INSERT INTO wallet_bindings(identity_id,workspace_id,cdp_user_id,eoa_address) VALUES($1,$2,'live','${ADDRESS}')`,
      [OWNER, WORKSPACE],
    );
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await database?.close();
  });

  it('wallet_balance shows about 0.0182 ETH on Arbitrum', async () => {
    const balance = (await agentWalletTool(database, 'balance', AGENT)) as {
      totalUsd: string;
      coins: Array<{ symbol: string; chain: string; amount: string; usd: string }>;
      unreadChains?: string[];
    };
    const quote = (await agentWalletTool(database, 'quote', AGENT, {
      chain: 'arbitrum',
      asset: 'eth',
      amount: '0.001',
    })) as { available: string; sufficient: boolean };
    const chains = (await agentWalletTool(database, 'chains', AGENT)) as {
      chains: Array<{ id: string; hasBalance: boolean }>;
    };
    const history = (await agentWalletTool(database, 'history', AGENT)) as {
      entries: Array<{ direction: string; amountText: string; chain: string }>;
    };
    console.log(JSON.stringify({ balance, quote, chains: chains.chains, history: history.entries }, null, 2));
    const eth = balance.coins.find((coin) => coin.chain === 'arbitrum' && coin.symbol === 'eth');
    expect(Number(eth?.amount)).toBeCloseTo(0.0182, 3);
    expect(balance.totalUsd).not.toBe('$0.00');
    expect(quote.sufficient).toBe(true);
    expect(chains.chains.find((chain) => chain.id === 'arbitrum')?.hasBalance).toBe(true);
    expect(history.entries.some((entry) => entry.direction === 'in' && entry.chain === 'arbitrum')).toBe(true);
  });
});
