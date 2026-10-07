/**
 * Wallet connector — the server authority over Coinbase CDP Server Wallets.
 *
 * Invariants (captain, 2026-09):
 *  - ONE app-wide Coinbase credential, held by the Beeline SERVER. No end
 *    user ever provisions a key; nothing here ever enters a Trusty Squire
 *    vault. The credential comes from server secrets only.
 *  - A wallet belongs to the HUMAN whose identity created it (one binding
 *    row per identity: this account owns that wallet — never a secret).
 *  - The funded balance IS the limit. The only refusal is insufficient
 *    funds. Wallet resource approvals and signing delegation still apply.
 *  - Every transaction, inbound AND out, appends ONE ledger line to the
 *    @wallet DM (the hidden connector identity's read-only thread) carrying
 *    amount, counterparty, chain and the BALANCE REMAINING. Outbound lines
 *    name the agent that spent. The insufficient-funds notice is the one
 *    non-transaction message. There is no daily roll-up.
 *
 * All Coinbase calls go through the one `CdpWalletSource` seam (`cdp-client.ts`).
 * The real client is used when the CDP env secrets exist; tests and
 * unconfigured servers use the fake (`cdp-fake.ts`), which never touches the
 * network and invents no credential.
 *
 * CDP Server-Wallet model: no "end-user" entity. A wallet IS an EVM account
 * identified by its address. The account name is deterministic per identity
 * (stable so the same wallet is returned).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import {
  walletAssetName,
  walletExplorerTxUrl,
  isWalletChainId,
  WALLET_CHAIN_IDS,
  WALLET_CHAIN_NAMES,
  type WalletChainId,
  type WalletCoinView,
  type WalletLedgerEntry,
  type WalletSendInput,
  type WalletSendOutcome,
  type WalletView,
  type WalletTypedData,
  type WalletSignTypedDataResult,
} from '@beeline/api-contract/wallet';
import { ensureConnectorDirectMessageRoom, ensureConnectorIdentity } from './workbench.js';
import { systemLine } from './system-line.js';
import { fakeCdpWalletSource } from './cdp-fake.js';
import { realCdpWalletSource, type CdpWalletSource } from './cdp-client.js';
import {
  HYPERLIQUID_BRIDGE2,
  HYPERLIQUID_MIN_DEPOSIT_USDC,
  formatUnits,
  parseUnits,
} from './evm-chain.js';

export { fakeCdpWalletSource } from './cdp-fake.js';
export type { CdpWalletSource } from './cdp-client.js';

/**
 * Derive a deterministic EVM account name from an identity id.
 * Must match CDP name pattern: ^[A-Za-z0-9][A-Za-z0-9-]{1,35}$ (2-36 chars).
 * Stable per identity so the same wallet is returned.
 */
function walletAccountName(identityId: string): string {
  const digest = createHash('sha256').update(identityId).digest('hex');
  return `bl${digest.slice(0, 32)}`;
}

/** Derive a deterministic Solana account name (distinct from the EVM one). */
function walletSolanaAccountName(identityId: string): string {
  const digest = createHash('sha256').update(identityId).digest('hex');
  return `bls${digest.slice(0, 32)}`;
}

let fakeSource: CdpWalletSource | null = null;

/** The ONE wallet source for this server process. */
export function walletSource(): CdpWalletSource {
  const real = realCdpWalletSource();
  if (real) return real;
  // Unconfigured servers run degraded on the fake: every screen and tool
  // works against an isolated in-memory wallet. No credential is invented.
  if (!fakeSource) fakeSource = fakeCdpWalletSource();
  return fakeSource;
}

export type WalletBinding = {
  accountName: string;
  eoaAddress: string;
  solanaAddress: string | null;
};

/** The signed-in identity's wallet binding, or null when they have none. */
export async function walletBinding(
  database: SqlDatabase,
  identityId: string,
): Promise<WalletBinding | null> {
  const row = (
    await database.query<{
      cdp_user_id: string;
      eoa_address: string;
      solana_address: string | null;
    }>(`SELECT cdp_user_id,eoa_address,solana_address FROM wallet_bindings WHERE identity_id=$1`, [
      identityId,
    ])
  ).rows[0];
  if (!row) return null;
  return {
    accountName: row.cdp_user_id,
    eoaAddress: row.eoa_address,
    solanaAddress: row.solana_address,
  };
}

/**
 * One tap creates the wallet: a CDP Server-Wallet EVM account is created
 * under the app credential and bound to the signed-in Beeline identity.
 * The account name is deterministic per identity so the same wallet is
 * returned on re-create. No Coinbase account, no key of their own.
 */
export async function createWallet(
  database: SqlDatabase,
  identityId: string,
  workspaceId: string,
  source: CdpWalletSource = walletSource(),
): Promise<WalletView> {
  const existing = await walletBinding(database, identityId);
  if (!existing) {
    const name = walletAccountName(identityId);
    const account = await source.createEvmAccount(name);
    await database.query(
      `INSERT INTO wallet_bindings(identity_id,workspace_id,cdp_user_id,eoa_address)
       VALUES ($1,$2,$3,$4) ON CONFLICT(identity_id) DO NOTHING`,
      [identityId, workspaceId, name, account.address],
    );
    // The @wallet thread exists from the moment the wallet does.
    await ensureConnectorDirectMessageRoom(database, workspaceId, 'wallet', identityId);
  }
  return readWalletView(database, identityId, workspaceId, source);
}

/** The phone's wallet read; the Solana account is created on first read. */
export async function readWallet(
  database: SqlDatabase,
  identityId: string,
  workspaceId: string,
): Promise<WalletView> {
  const view = await readWalletView(database, identityId, workspaceId);
  try {
    const solanaAddress = await ensureSolanaAddress(database, identityId);
    return { ...view, solanaAddress };
  } catch {
    return view;
  }
}

/**
 * Solana is a SEPARATE CDP Wallet account — created on demand, because the
 * receive screen is the only place it appears.
 */
export async function ensureSolanaAddress(
  database: SqlDatabase,
  identityId: string,
  source: CdpWalletSource = walletSource(),
): Promise<string> {
  const binding = await walletBinding(database, identityId);
  if (!binding) throw new Error('wallet not created');
  if (binding.solanaAddress) return binding.solanaAddress;
  const name = walletSolanaAccountName(identityId);
  const account = await source.createSolanaAccount(name);
  await database.query(
    `UPDATE wallet_bindings SET solana_address=$2,updated_at=now() WHERE identity_id=$1`,
    [identityId, account.address],
  );
  return account.address;
}

export async function readWalletView(
  database: SqlDatabase,
  identityId: string,
  workspaceId: string,
  source: CdpWalletSource = walletSource(),
): Promise<WalletView> {
  const binding = await walletBinding(database, identityId);
  if (!binding) throw new Error('wallet not created');
  await reconcileInbound(database, identityId, workspaceId, source, binding.eoaAddress);
  const holdings = await readHoldings(source, binding.eoaAddress);
  await reconcileBalancesSafely(database, { ownerIdentityId: identityId, workspaceId, binding }, holdings);
  const sponsorship = await source.sponsorshipAllowance();
  return {
    address: binding.eoaAddress,
    solanaAddress: binding.solanaAddress,
    totalUsd: formatUsd(holdingsUsd(holdings.coins)),
    coins: holdings.coins,
    chains: await chainViews(source, holdings),
    sponsorship: sponsorship
      ? {
          usedUsd: formatUsd(sponsorship.usedUsd),
          limitUsd: formatUsd(sponsorship.limitUsd),
        }
      : null,
    delegation: await delegationView(database, identityId),
  };
}

export async function delegationView(
  database: SqlDatabase,
  identityId: string,
): Promise<{ active: boolean; expiresAt: number | null }> {
  const row = (
    await database.query<{ delegation_expires_at: Date | null; delegation_standing: boolean }>(
      `SELECT delegation_expires_at,delegation_standing FROM wallet_bindings WHERE identity_id=$1`,
      [identityId],
    )
  ).rows[0];
  const expiresAt = row?.delegation_expires_at ? row.delegation_expires_at.getTime() : null;
  return {
    active: row?.delegation_standing === true || (expiresAt !== null && expiresAt > Date.now()),
    expiresAt,
  };
}

/**
 * The user (present, on their phone) grants or renews the delegated-signing
 * grant. One user-scoped delegation is active at a time: granting replaces
 * a legacy expiry with a standing grant. A grant is announced in the @wallet thread
 * so the ledger shows WHY agents can spend.
 */
export async function grantWalletDelegation(
  database: SqlDatabase,
  identityId: string,
  workspaceId: string,
): Promise<{ expiresAt: null }> {
  const binding = await walletBinding(database, identityId);
  if (!binding) throw new Error('wallet not created');
  await database.query(
    `UPDATE wallet_bindings SET delegation_expires_at=NULL,delegation_standing=true,updated_at=now() WHERE identity_id=$1`,
    [identityId],
  );
  const connectorId = await ensureConnectorIdentity(database, 'wallet');
  const roomId = await ensureConnectorDirectMessageRoom(
    database,
    workspaceId,
    'wallet',
    identityId,
  );
  await systemLine(database, {
    roomId,
    authorId: connectorId,
    subject: { id: connectorId, kind: 'person', name: 'Wallet' },
    verb: 'granted',
    object: { text: 'agents permission to sign' },
    consequence: 'until revoked',
    presentation: 'card',
    cardType: 'wallet-delegation',
    card: { standing: true },
  });
  return { expiresAt: null };
}

/**
 * Agent spending REQUIRES a live delegation. The phone's own send (the
 * human, present) does not — the human is the grantor. An expired grant is
 * a named outcome the agent must surface, never a silent failure.
 */
export async function assertAgentDelegation(
  database: SqlDatabase,
  identityId: string,
): Promise<boolean> {
  const delegation = await delegationView(database, identityId);
  return delegation.active;
}

function usdValue(coin: WalletCoinView): number {
  return Number(coin.usd.replace(/[$,]/g, ''));
}

export function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export type WalletHoldings = {
  /** Every holding on every chain, each tagged with its chain. */
  coins: WalletCoinView[];
  /** Chains whose balance could not be read; their holdings are unknown, not zero. */
  unreadChains: WalletChainId[];
};

/** The ONE balance read: every listed chain, in parallel. */
export async function readHoldings(
  source: CdpWalletSource,
  address: string,
): Promise<WalletHoldings> {
  const reads = await Promise.allSettled(
    WALLET_CHAIN_IDS.map((chain) => source.balances(chain, address)),
  );
  const coins: WalletCoinView[] = [];
  const unreadChains: WalletChainId[] = [];
  reads.forEach((read, index) => {
    const chain = WALLET_CHAIN_IDS[index]!;
    if (read.status === 'fulfilled') coins.push(...read.value.map((coin) => ({ ...coin, chain })));
    else {
      unreadChains.push(chain);
      console.error(
        `[wallet] ${chain} balance read failed for ${address}:`,
        read.reason instanceof Error ? read.reason.message : read.reason,
      );
    }
  });
  return { coins, unreadChains };
}

function holdingsUsd(coins: readonly WalletCoinView[]): number {
  return coins.reduce((sum, coin) => sum + usdValue(coin), 0);
}

function chainCoins(holdings: WalletHoldings, chain: WalletChainId): WalletCoinView[] {
  return holdings.coins.filter((coin) => coin.chain === chain);
}

/** Chain picker rows; `hasBalance` comes from the same holdings as the balance. */
async function chainViews(source: CdpWalletSource, holdings: WalletHoldings) {
  const chains = [];
  for (const chain of WALLET_CHAIN_IDS) {
    const fee = await source.feeEstimate(chain);
    chains.push({
      id: chain,
      name: WALLET_CHAIN_NAMES[chain],
      ...(fee.feeUsd !== null ? { feeUsd: fee.feeUsd.toFixed(2) } : { feeUsd: null }),
      sponsored: fee.sponsored,
      hasBalance: chainCoins(holdings, chain).some((coin) => Number(coin.amount) > 0),
    });
  }
  return chains;
}

/** Snapshot amounts compare at 18 decimals, the most any listed asset uses. */
const SNAPSHOT_DECIMALS = 18;

/**
 * Inbound transfers, found from balance increases. CDP v2 has no address
 * history for server wallets, so each read compares every (chain, asset)
 * holding with the last snapshot; an increase is recorded as one inbound
 * transaction and ledger line. The snapshot update is compare-and-set, so
 * concurrent reads record an increase once. Unread chains are skipped.
 */
export async function reconcileBalances(
  database: SqlDatabase,
  identityId: string,
  workspaceId: string,
  holdings: WalletHoldings,
): Promise<number> {
  const snapshots = new Map(
    (
      await database.query<{ chain: string; asset: string; amount: string }>(
        `SELECT chain,asset,amount FROM wallet_balance_snapshots WHERE identity_id=$1`,
        [identityId],
      )
    ).rows.map((row) => [`${row.chain}:${row.asset}`, row.amount]),
  );
  const current = new Map<string, { chain: WalletChainId; asset: string; amount: string }>();
  for (const coin of holdings.coins)
    if (coin.chain) current.set(`${coin.chain}:${coin.symbol}`, { chain: coin.chain, asset: coin.symbol, amount: coin.amount });
  for (const key of snapshots.keys()) {
    const [chain, asset] = key.split(':') as [WalletChainId, string];
    if (!current.has(key)) current.set(key, { chain, asset, amount: '0' });
  }
  const balanceAfterUsd = formatUsd(holdingsUsd(holdings.coins));
  let added = 0;
  for (const [key, row] of current) {
    if (holdings.unreadChains.includes(row.chain)) continue;
    const previous = snapshots.get(key);
    const before = previous === undefined ? 0n : parseUnits(previous, SNAPSHOT_DECIMALS);
    const after = parseUnits(row.amount, SNAPSHOT_DECIMALS);
    if (previous !== undefined && after === before) continue;
    const stored =
      previous === undefined
        ? await database.query(
            `INSERT INTO wallet_balance_snapshots(identity_id,chain,asset,amount)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [identityId, row.chain, row.asset, row.amount],
          )
        : await database.query(
            `UPDATE wallet_balance_snapshots SET amount=$4,updated_at=now()
             WHERE identity_id=$1 AND chain=$2 AND asset=$3 AND amount=$5`,
            [identityId, row.chain, row.asset, row.amount, previous],
          );
    if (stored.rowCount !== 1 || after <= before) continue;
    const amount = formatUnits(after - before, SNAPSHOT_DECIMALS);
    const createdAt = Date.now();
    await recordTransaction(database, identityId, {
      txId: createHash('sha256')
        .update(`balance:${row.chain}:${row.asset}:${previous ?? '0'}:${row.amount}:${createdAt}`)
        .digest('hex'),
      direction: 'in',
      asset: row.asset,
      amount,
      counterparty: INBOUND_COUNTERPARTY,
      chain: row.chain,
      balanceAfterUsd,
      agentId: null,
      txUrl: '',
    });
    await postLedgerLine(database, workspaceId, identityId, {
      direction: 'in',
      agentName: null,
      amountText: `+${amount} ${row.asset.toUpperCase()}`,
      counterparty: INBOUND_COUNTERPARTY,
      chain: row.chain,
      balanceAfterUsd,
      txUrl: null,
      createdAt,
    });
    added += 1;
  }
  return added;
}

/** A balance increase carries no sender; the ledger says so plainly. */
const INBOUND_COUNTERPARTY = 'deposit (sender not indexed)';

/** Credit a swap's expected output to the snapshot so it is not read as a deposit. */
async function creditSnapshot(
  database: SqlDatabase,
  identityId: string,
  chain: WalletChainId,
  asset: string,
  amount: string,
): Promise<void> {
  const previous = (
    await database.query<{ amount: string }>(
      `SELECT amount FROM wallet_balance_snapshots WHERE identity_id=$1 AND chain=$2 AND asset=$3`,
      [identityId, chain, asset],
    )
  ).rows[0]?.amount;
  const total = formatUnits(
    parseUnits(previous ?? '0', SNAPSHOT_DECIMALS) + parseUnits(amount, SNAPSHOT_DECIMALS),
    SNAPSHOT_DECIMALS,
  );
  await database.query(
    `INSERT INTO wallet_balance_snapshots(identity_id,chain,asset,amount) VALUES ($1,$2,$3,$4)
     ON CONFLICT(identity_id,chain,asset) DO UPDATE SET amount=EXCLUDED.amount,updated_at=now()`,
    [identityId, chain, asset, total],
  );
}

/**
 * Send on a named chain. The funded balance is the only gate: a payment
 * larger than what the asset holds moves nothing and posts the one
 * non-transaction ledger message. `agentId` (when present) is the agent that
 * spent and is named on the outbound line.
 */
export async function sendFromWallet(
  database: SqlDatabase,
  identityId: string,
  workspaceId: string,
  input: WalletSendInput,
  agentId?: string,
): Promise<WalletSendOutcome> {
  const binding = await walletBinding(database, identityId);
  if (!binding) throw new Error('wallet not created');
  // An agent spends only under a live delegated-signing grant.
  if (agentId && !(await assertAgentDelegation(database, identityId))) {
    return { outcome: 'delegation-expired' };
  }
  const source = walletSource();
  const coins = (await readHoldings(source, binding.eoaAddress)).coins;
  const holding = coins.find(
    (coin) => coin.chain === input.chain && coin.symbol.toLowerCase() === input.asset.toLowerCase(),
  );
  const needed = Number(input.amount);
  const available = Number(holding?.amount ?? '0');
  if (!holding || Number.isNaN(needed) || needed <= 0 || needed > available) {
    const symbol = (holding?.symbol ?? input.asset).toUpperCase();
    await postInsufficientNotice(database, identityId, workspaceId, input, {
      needed: input.amount,
      available: holding?.amount ?? '0',
      asset: symbol,
      agentName: agentId ? await agentName(database, agentId) : null,
    });
    return {
      outcome: 'insufficient',
      asset: symbol,
      needed: input.amount,
      available: holding?.amount ?? '0',
    };
  }

  const sent = await source.sendTransaction(binding.eoaAddress, input);
  // Balance after: the same holdings with what moved subtracted, in USD —
  // the line carries what it left behind, not what it spent.
  const balanceAfterUsd = formatUsd(
    coins.reduce(
      (sum, coin) =>
        sum +
        (coin === holding
          ? usdValue(coin) * (1 - needed / available)
          : usdValue(coin)),
      0,
    ),
  );
  const amountText = `−${input.amount} ${holding.symbol.toUpperCase()}`;
  const txUrl = walletExplorerTxUrl(input.chain, sent.txId);
  await recordTransaction(database, identityId, {
    txId: sent.txId,
    direction: 'out',
    asset: holding.symbol,
    amount: input.amount,
    counterparty: input.to,
    chain: input.chain,
    balanceAfterUsd,
    agentId: agentId ?? null,
    txUrl,
  });
  await postLedgerLine(database, workspaceId, identityId, {
    direction: 'out',
    agentName: agentId ? await agentName(database, agentId) : null,
    amountText,
    counterparty: input.to,
    chain: input.chain,
    balanceAfterUsd,
    txUrl,
    createdAt: Date.now(),
  });
  return { outcome: 'sent', txUrl, amountText, balanceAfterUsd };
}

async function agentName(database: SqlDatabase, agentId: string): Promise<string | null> {
  const row = (
    await database.query<{ name: string; handle: string | null }>(
      `SELECT name,handle FROM identities WHERE id=$1`,
      [agentId],
    )
  ).rows[0];
  return row?.handle ? `@${row.handle}` : (row?.name ?? null);
}

type RecordedTx = {
  txId: string;
  direction: 'in' | 'out';
  asset: string;
  amount: string;
  counterparty: string;
  chain: WalletChainId;
  balanceAfterUsd: string;
  agentId: string | null;
  txUrl: string;
};

async function recordTransaction(
  database: SqlDatabase,
  identityId: string,
  tx: RecordedTx,
): Promise<void> {
  await database.query(
    `INSERT INTO wallet_transactions(
       id,identity_id,tx_id,direction,asset,amount,counterparty,chain,
       balance_after_usd,agent_id,tx_url
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT(identity_id,tx_id) DO NOTHING`,
    [
      randomUUID(),
      identityId,
      tx.txId,
      tx.direction,
      tx.asset,
      tx.amount,
      tx.counterparty,
      tx.chain,
      tx.balanceAfterUsd,
      tx.agentId,
      tx.txUrl,
    ],
  );
}

/**
 * Deposits the wallet did not originate. Reconciles the source's transaction
 * history against our rows; anything unseen is an inbound deposit, recorded
 * and announced as one inbound ledger line. Runs on wallet reads, so a
 * deposit shows up the next time the owner looks at their money.
 */
export async function reconcileInbound(
  database: SqlDatabase,
  identityId: string,
  workspaceId: string,
  source: CdpWalletSource = walletSource(),
  address: string,
): Promise<number> {
  const known = new Set(
    (
      await database.query<{ tx_id: string }>(
        `SELECT tx_id FROM wallet_transactions WHERE identity_id=$1`,
        [identityId],
      )
    ).rows.map((row) => row.tx_id),
  );
  // History is enrichment: a wallet must be fully usable (address + balances)
  // even when the transaction history read fails (it currently 401s — the
  // CDP v2 history endpoint is unconfirmed). Log once and skip reconciliation.
  let history: WalletLedgerEntry[];
  try {
    history = await source.history(address, 50);
  } catch (error) {
    console.error(
      `[wallet] history read failed for ${address}; skipping inbound reconciliation:`,
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
  let added = 0;
  for (const entry of history) {
    if (entry.direction !== 'in' || !entry.txUrl) continue;
    // A source row has no identity of its own beyond its explorer link and
    // time, so the reconciliation key is that pair.
    const txId = createHash('sha256').update(`${entry.txUrl}:${entry.createdAt}`).digest('hex');
    if (known.has(txId)) continue;
    await recordTransaction(database, identityId, {
      txId,
      direction: 'in',
      asset: entryAsset(entry.amountText),
      amount: entryAmount(entry.amountText),
      counterparty: entry.counterparty,
      chain: entry.chain,
      balanceAfterUsd: entry.balanceAfterUsd,
      agentId: null,
      txUrl: entry.txUrl,
    });
    await postLedgerLine(database, workspaceId, identityId, entry);
    added += 1;
  }
  return added;
}

function entryAmount(amountText: string): string {
  return amountText
    .replace(/^[+\-−]/, '')
    .replace(/\s*[A-Za-z]+$/, '')
    .trim();
}
function entryAsset(amountText: string): string {
  const match = amountText.match(/([A-Za-z]+)\s*$/);
  return (match?.[1] ?? 'USD').toLowerCase();
}

/** The owner's ledger history, oldest first, bounded. */
export async function walletHistory(
  database: SqlDatabase,
  identityId: string,
  limit: number,
): Promise<WalletLedgerEntry[]> {
  const rows = (
    await database.query<{
      direction: 'in' | 'out';
      asset: string;
      amount: string;
      counterparty: string;
      chain: WalletChainId;
      balance_after_usd: string;
      agent_id: string | null;
      agent_handle: string | null;
      agent_name: string | null;
      tx_url: string;
      created_at: Date;
    }>(
      `SELECT t.direction,t.asset,t.amount,t.counterparty,t.chain,t.balance_after_usd,
              t.agent_id,t.tx_url,t.created_at,
              i.handle AS agent_handle,i.name AS agent_name
       FROM wallet_transactions t
       LEFT JOIN identities i ON i.id=t.agent_id
       WHERE t.identity_id=$1
       ORDER BY t.created_at DESC LIMIT $2`,
      [identityId, Math.min(Math.max(limit, 1), 100)],
    )
  ).rows;
  return rows
    .map((row) => ({
      direction: row.direction,
      // Outbound names the agent that spent; inbound is the wallet receiving.
      agentName:
        row.direction === 'out' && row.agent_id
          ? row.agent_handle
            ? `@${row.agent_handle}`
            : (row.agent_name ?? 'an agent')
          : null,
      amountText:
        row.direction === 'in'
          ? `+${row.amount} ${row.asset.toUpperCase()}`
          : `−${row.amount} ${row.asset.toUpperCase()}`,
      counterparty: row.counterparty,
      chain: row.chain,
      balanceAfterUsd: row.balance_after_usd,
      txUrl: row.tx_url || null,
      createdAt: row.created_at.getTime(),
    }))
    .reverse();
}

/**
 * One ledger line from the @wallet connector identity. A card, not chat: the
 * thread is a ledger the connector identity alone writes to.
 */
export async function postLedgerLine(
  database: SqlDatabase,
  workspaceId: string,
  identityId: string,
  entry: WalletLedgerEntry,
): Promise<void> {
  const connectorId = await ensureConnectorIdentity(database, 'wallet');
  const roomId = await ensureConnectorDirectMessageRoom(
    database,
    workspaceId,
    'wallet',
    identityId,
  );
  await systemLine(database, {
    roomId,
    authorId: connectorId,
    id: ledgerLineId(entry),
    subject: { id: connectorId, kind: 'person', name: 'Wallet' },
    verb: entry.direction === 'in' ? 'received' : 'sent',
    object: {
      text: entry.amountText.replace(/^[+\-−]/, ''),
      ...(entry.txUrl ? { url: entry.txUrl } : {}),
    },
    ...(entry.direction === 'out' && entry.agentName ? { consequence: entry.agentName } : {}),
    presentation: 'card',
    cardType: 'wallet-tx',
    card: {
      direction: entry.direction,
      amountText: entry.amountText,
      counterparty: entry.counterparty,
      chain: entry.chain,
      balanceAfterUsd: entry.balanceAfterUsd,
      ...(entry.txUrl ? { txUrl: entry.txUrl } : {}),
    },
  });
}

/** A deterministic id makes a replayed reconciliation idempotent. */
function ledgerLineId(entry: WalletLedgerEntry): string {
  return createHash('sha256')
    .update(
      `wallet-ledger:${entry.direction}:${entry.counterparty}:${entry.amountText}:${entry.chain}:${entry.createdAt}`,
    )
    .digest('hex');
}

/**
 * The one non-transaction message: the payment that did not happen, because
 * only the human can fix it. Names the agent that tried and what is there.
 */
export async function postInsufficientNotice(
  database: SqlDatabase,
  identityId: string,
  workspaceId: string,
  input: { chain: WalletChainId; asset: string; amount: string },
  detail: { needed: string; available: string; asset: string; agentName: string | null },
): Promise<void> {
  const connectorId = await ensureConnectorIdentity(database, 'wallet');
  const roomId = await ensureConnectorDirectMessageRoom(
    database,
    workspaceId,
    'wallet',
    identityId,
  );
  // Bucketed to the minute: a retried attempt inside the window collides and
  // writes nothing, a later attempt announces itself once more.
  const id = createHash('sha256')
    .update(
      `wallet-insufficient:${identityId}:${detail.agentName ?? ''}:${input.amount}:${detail.asset}:${Math.floor(Date.now() / 60_000)}`,
    )
    .digest('hex');
  await systemLine(database, {
    roomId,
    authorId: connectorId,
    id,
    subject: { id: connectorId, kind: 'person', name: 'Wallet' },
    verb: 'refused',
    object: { text: `${input.amount} ${input.asset.toUpperCase()}` },
    consequence: 'not enough',
    presentation: 'card',
    cardType: 'wallet-insufficient',
    card: {
      agentName: detail.agentName,
      needed: detail.needed,
      available: detail.available,
      asset: detail.asset,
      chain: input.chain,
    },
  });
}

export { isWalletChainId };

// --- Agent tool helpers (daemon operations) ------------------------------------

export type WalletAgentContext = {
  ownerIdentityId: string;
  workspaceId: string;
  binding: WalletBinding;
};

/**
 * Resolve the AGENT to its connected owner's wallet. Membership is the
 * authority: the agent must hold a CURRENT Workspace membership and its
 * owner must own a wallet; nothing else (room roles, opener, sender)
 * authorizes a wallet tool call.
 */
export async function walletAgentContext(
  database: SqlDatabase,
  agentId: string,
): Promise<WalletAgentContext | null> {
  const row = (
    await database.query<{ owner_id: string; workspace_id: string }>(
      `SELECT a.owner_id, m.workspace_id
       FROM agents a
       JOIN memberships m ON m.identity_id=a.agent_id
         AND m.room_id IS NULL AND m.removed_at IS NULL
       WHERE a.agent_id=$1`,
      [agentId],
    )
  ).rows[0];
  if (!row) return null;
  const binding = await walletBinding(database, row.owner_id);
  if (!binding) return null;
  return { ownerIdentityId: row.owner_id, workspaceId: row.workspace_id, binding };
}

/** The agent-facing wallet tools: one entry point per daemon operation. */
export async function agentWalletTool(
  database: SqlDatabase,
  op:
    | 'state'
    | 'balance'
    | 'chains'
    | 'history'
    | 'quote'
    | 'pay'
    | 'swap'
    | 'hyperliquid-deposit',
  agentId: string,
  input?: {
    chain?: WalletChainId;
    limit?: number;
    asset?: string;
    amount?: string;
    fromAsset?: string;
    toAsset?: string;
    to?: string;
  },
): Promise<unknown> {
  const source = walletSource();
  const ctx = await walletAgentContext(database, agentId);
  if (op === 'state') {
    return {
      ownerIdentityId: ctx?.ownerIdentityId ?? null,
      wallet: ctx
        ? {
            address: ctx.binding.eoaAddress,
            solanaAddress: ctx.binding.solanaAddress,
          }
        : null,
    };
  }
  if (!ctx) throw new Error('no wallet: the agent has no connected owner with a wallet');
  const address = ctx.binding.eoaAddress;
  const chain = input?.chain ?? 'base';
  const holdings = async (): Promise<WalletHoldings> => {
    const read = await readHoldings(source, address);
    await reconcileBalancesSafely(database, ctx, read);
    return read;
  };
  switch (op) {
    case 'balance': {
      const read = await holdings();
      return {
        totalUsd: formatUsd(holdingsUsd(read.coins)),
        coins: read.coins,
        ...(read.unreadChains.length ? { unreadChains: read.unreadChains } : {}),
      };
    }
    case 'chains':
      return { chains: await chainViews(source, await holdings()) };
    case 'history':
      await holdings();
      return { entries: await walletHistory(database, ctx.ownerIdentityId, input?.limit ?? 20) };
    case 'quote': {
      const fee = await source.feeEstimate(validChain(chain));
      const read = await holdings();
      const symbol = (input?.asset ?? 'usdc').toLowerCase();
      const available =
        chainCoins(read, chain).find((coin) => coin.symbol === symbol)?.amount ?? '0';
      return {
        feeUsd: fee.feeUsd !== null ? fee.feeUsd.toFixed(2) : null,
        sponsored: fee.sponsored,
        sufficient: Number(available) >= Number(input?.amount ?? 0),
        available,
        asset: symbol,
        chain,
        ...(read.unreadChains.includes(chain) ? { unread: true } : {}),
      };
    }
    case 'pay': {
      return await agentSend(database, ctx, agentId, {
        chain: validChain(chain),
        asset: input?.asset ?? 'usdc',
        amount: input?.amount ?? '',
        to: input?.to ?? '',
      });
    }
    case 'hyperliquid-deposit': {
      const amount = input?.amount ?? '';
      if (!(Number(amount) >= HYPERLIQUID_MIN_DEPOSIT_USDC))
        return {
          outcome: 'failed',
          reason: `Hyperliquid Bridge2 deposits must be at least ${HYPERLIQUID_MIN_DEPOSIT_USDC} USDC; a smaller deposit is never credited and is lost`,
        };
      return await agentSend(database, ctx, agentId, {
        chain: 'arbitrum',
        asset: 'usdc',
        amount,
        to: HYPERLIQUID_BRIDGE2,
      });
    }
    case 'swap': {
      if (!(await assertAgentDelegation(database, ctx.ownerIdentityId))) {
        return { outcome: 'delegation-expired' };
      }
      const swapChain = validChain(chain);
      const fromAsset = (input?.fromAsset ?? 'usdc').toLowerCase();
      const toAsset = (input?.toAsset ?? 'eth').toLowerCase();
      const amount = input?.amount ?? '';
      try {
        const before = await holdings();
        const swapped = await source.swap(address, { chain: swapChain, fromAsset, toAsset, amount });
        await creditSnapshot(database, ctx.ownerIdentityId, swapChain, toAsset, swapped.toAmount);
        // A swap trades value for value; the wallet total is unchanged but for fees.
        const totalUsd = holdingsUsd(before.coins);
        const fromAmountText = `−${amount} ${fromAsset.toUpperCase()}`;
        const toAmountText = `+${swapped.toAmount} ${toAsset.toUpperCase()}`;
        const txUrl = walletExplorerTxUrl(swapChain, swapped.txId);
        await postLedgerLine(database, ctx.workspaceId, ctx.ownerIdentityId, {
          direction: 'out',
          agentName: await agentName(database, agentId),
          amountText: `${fromAmountText} ${toAmountText}`,
          counterparty: `swap ${fromAsset.toUpperCase()}→${toAsset.toUpperCase()}`,
          chain: swapChain,
          balanceAfterUsd: formatUsd(totalUsd),
          txUrl,
          createdAt: Date.now(),
        });
        await recordTransaction(database, ctx.ownerIdentityId, {
          txId: swapped.txId,
          direction: 'out',
          asset: fromAsset,
          amount,
          counterparty: `swap→${toAsset.toUpperCase()}`,
          chain: swapChain,
          balanceAfterUsd: formatUsd(totalUsd),
          txUrl,
          agentId,
        });
        return {
          outcome: 'sent',
          txUrl,
          fromAmountText,
          toAmountText,
          balanceAfterUsd: formatUsd(totalUsd),
        };
      } catch (error) {
        return handleSendFailure(database, ctx, agentId, error, fromAsset, amount, swapChain);
      }
    }
  }
}

function validChain(chain: unknown): WalletChainId {
  if (!isWalletChainId(chain)) throw new Error(`unknown chain: ${String(chain)}`);
  return chain;
}

/** A failed snapshot reconciliation never blocks a balance read or a send. */
async function reconcileBalancesSafely(
  database: SqlDatabase,
  ctx: WalletAgentContext,
  holdings: WalletHoldings,
): Promise<void> {
  try {
    await reconcileBalances(database, ctx.ownerIdentityId, ctx.workspaceId, holdings);
  } catch (error) {
    console.error(
      `[wallet] balance reconciliation failed for ${ctx.binding.eoaAddress}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** One agent-initiated send: delegation gate, source call, ledger + record. */
async function agentSend(
  database: SqlDatabase,
  ctx: WalletAgentContext,
  agentId: string,
  input: WalletSendInput,
): Promise<WalletSendOutcome> {
  if (!(await assertAgentDelegation(database, ctx.ownerIdentityId))) {
    return { outcome: 'delegation-expired' };
  }
  const source = walletSource();
  const holdings = await readHoldings(source, ctx.binding.eoaAddress);
  await reconcileBalancesSafely(database, ctx, holdings);
  const symbol = input.asset.toLowerCase();
  const holding = chainCoins(holdings, input.chain).find((coin) => coin.symbol === symbol);
  const available = holding?.amount ?? '0';
  if (Number(input.amount) > Number(available)) {
    await postInsufficientNotice(
      database,
      ctx.ownerIdentityId,
      ctx.workspaceId,
      { chain: input.chain, asset: input.asset, amount: input.amount },
      {
        needed: input.amount,
        available,
        asset: symbol,
        agentName: await agentName(database, agentId),
      },
    );
    return { outcome: 'insufficient', asset: symbol, needed: input.amount, available };
  }
  try {
    const sent = await source.sendTransaction(ctx.binding.eoaAddress, input);
    // What the send left behind: the same holdings with the spent share removed.
    const totalUsd =
      holdingsUsd(holdings.coins) -
      (holding ? usdValue(holding) * (Number(input.amount) / Number(available)) : 0);
    const txUrl = walletExplorerTxUrl(input.chain, sent.txId);
    await postLedgerLine(database, ctx.workspaceId, ctx.ownerIdentityId, {
      direction: 'out',
      agentName: await agentName(database, agentId),
      amountText: `−${input.amount} ${symbol.toUpperCase()}`,
      counterparty: input.to,
      chain: input.chain,
      balanceAfterUsd: formatUsd(totalUsd),
      createdAt: Date.now(),
      txUrl,
    });
    await recordTransaction(database, ctx.ownerIdentityId, {
      txId: sent.txId,
      direction: 'out',
      asset: symbol,
      amount: input.amount,
      counterparty: input.to,
      chain: input.chain,
      balanceAfterUsd: formatUsd(totalUsd),
      txUrl,
      agentId,
    });
    return {
      outcome: 'sent',
      txUrl,
      amountText: `−${input.amount} ${symbol.toUpperCase()}`,
      balanceAfterUsd: formatUsd(totalUsd),
    };
  } catch (error) {
    return handleSendFailure(database, ctx, agentId, error, symbol, input.amount, input.chain);
  }
}

/**
 * A failed source call is a durable failure fact: one ledger line in the
 * @wallet DM naming the agent, asset and amount, and the outcome the tool
 * reports back. A failed send is never silent and never retried here.
 */
async function handleSendFailure(
  database: SqlDatabase,
  ctx: WalletAgentContext,
  agentId: string,
  error: unknown,
  asset: string,
  amount: string,
  chain: WalletChainId,
): Promise<WalletSendOutcome> {
  const reason = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
  const connectorId = await ensureConnectorIdentity(database, 'wallet');
  const roomId = await ensureConnectorDirectMessageRoom(
    database,
    ctx.workspaceId,
    'wallet',
    ctx.ownerIdentityId,
  );
  const id = createHash('sha256')
    .update(
      `wallet-failed:${ctx.ownerIdentityId}:${asset}:${amount}:${reason}:${Math.floor(Date.now() / 60_000)}`,
    )
    .digest('hex');
  await systemLine(database, {
    roomId,
    authorId: connectorId,
    id,
    subject: { id: connectorId, kind: 'person', name: 'Wallet' },
    verb: 'refused',
    object: { text: `${amount} ${asset.toUpperCase()}` },
    consequence: reason,
    presentation: 'card',
    cardType: 'wallet-insufficient',
    card: {
      agentName: await agentName(database, agentId),
      needed: amount,
      available: null,
      asset: asset.toUpperCase(),
      chain,
      reason,
    },
  });
  return { outcome: 'failed', reason };
}

/** Sign through the linked account after the daemon's wallet resource approval. */
export async function agentSignTypedData(
  database: SqlDatabase,
  agentId: string,
  input: WalletTypedData,
): Promise<WalletSignTypedDataResult> {
  const ctx = await walletAgentContext(database, agentId);
  if (!ctx) throw new Error('no wallet: the agent has no connected owner with a wallet');
  if (!(await assertAgentDelegation(database, ctx.ownerIdentityId)))
    return { outcome: 'delegation-expired' };
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (
    !object(input.domain) ||
    !object(input.types) ||
    !object(input.message) ||
    typeof input.primaryType !== 'string' ||
    !input.primaryType ||
    !Object.hasOwn(input.types, input.primaryType) ||
    !Object.values(input.types).every(
      (fields) =>
        Array.isArray(fields) &&
        fields.every(
          (field) =>
            object(field) &&
            typeof field.name === 'string' &&
            !!field.name &&
            typeof field.type === 'string' &&
            !!field.type,
        ),
    )
  )
    return { outcome: 'failed', reason: 'invalid EIP-712 typed data' };
  const payload = {
    domain: input.domain,
    types: input.types,
    primaryType: input.primaryType,
    message: input.message,
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > 64 * 1024)
    return { outcome: 'failed', reason: 'EIP-712 typed data exceeds 64 KB' };
  let signed: { signature: string };
  try {
    signed = await walletSource().signTypedData(ctx.binding.eoaAddress, payload);
  } catch (error) {
    return {
      outcome: 'failed',
      reason: error instanceof Error ? error.message : 'typed-data signing failed',
    };
  }
  const connectorId = await ensureConnectorIdentity(database, 'wallet');
  const roomId = await ensureConnectorDirectMessageRoom(
    database,
    ctx.workspaceId,
    'wallet',
    ctx.ownerIdentityId,
  );
  // This is an authorization audit, not an on-chain transaction. Never store
  // the reusable signature in a ledger card or manufacture a transfer amount.
  await systemLine(database, {
    roomId,
    authorId: connectorId,
    subject: { id: connectorId, kind: 'person', name: 'Wallet' },
    verb: 'signed',
    object: { text: 'EIP-712 typed data' },
    consequence: (await agentName(database, agentId)) ?? 'An agent',
    presentation: 'card',
    cardType: 'wallet-signature',
    card: {
      agentId,
      address: ctx.binding.eoaAddress,
      domain: input.domain,
      primaryType: input.primaryType,
      payloadSha256: createHash('sha256').update(serialized).digest('hex'),
    },
  });
  return { outcome: 'signed', signature: signed.signature };
}
