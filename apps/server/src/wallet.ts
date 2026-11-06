import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { createHash, randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { walletExplorerTxUrl, WALLET_CHAIN_IDS, WALLET_CHAIN_NAMES, type WalletChainId, type WalletCoinView, type WalletLedgerEntry, type WalletSendInput, type WalletSendOutcome, type WalletView } from '@beeline/api-contract/wallet';
import { ensureSystemDirectMessageRoom } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { systemLine } from './system-line.js';
import { fakeCdpWalletSource } from './cdp-fake.js';
import { realCdpWalletSource, type CdpWalletSource } from './cdp-client.js';
import { formatUnits, parseUnits } from './evm-chain.js';
import { reconcileBalancesSafely, delegationRefusal, postInsufficientNotice, handleSendFailure, postLedgerLine } from './wallet-post-ledger-line.js';
export { postLedgerLine, postInsufficientNotice, type WalletAgentContext, walletAgentContext, agentWalletTool, contractCallSpends, agentContractCall, agentSignTypedData } from './wallet-post-ledger-line.js';



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
    // Wallet notices share the owner's System thread.
    await ensureSystemDirectMessageRoom(database, workspaceId, identityId);
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
    const complete={ ...view, solanaAddress };
    return complete;
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
  const view:WalletView={
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
  return view;
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
  const roomId = await ensureSystemDirectMessageRoom(database, workspaceId, identityId);
  await systemLine(database, {
    roomId,
    authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'system', name: systemMessage("wallet.wallet") },
    verb: systemMessage("wallet.granted"),
    object: { text: systemMessage("wallet.agents-permission-to-sign") },
    consequence: systemMessage("wallet.until-revoked"),
    presentation: 'card',
    cardType: 'wallet-delegation',
    card: { standing: true },
  });
  return { expiresAt: null };
}


export async function revokeWalletDelegation(database: SqlDatabase, identityId: string): Promise<void> {
  // Clearing both forms also revokes legacy timed grants. Keep the binding and ledger.
  await database.query(
    `UPDATE wallet_bindings SET delegation_expires_at=NULL,delegation_standing=false,updated_at=now() WHERE identity_id=$1`,
    [identityId],
  );
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


export function usdValue(coin: WalletCoinView): number {
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


export function holdingsUsd(coins: readonly WalletCoinView[]): number {
  return coins.reduce((sum, coin) => sum + usdValue(coin), 0);
}


export function chainCoins(holdings: WalletHoldings, chain: WalletChainId): WalletCoinView[] {
  return holdings.coins.filter((coin) => coin.chain === chain);
}


/** Chain picker rows; `hasBalance` comes from the same holdings as the balance. */
export async function chainViews(source: CdpWalletSource, holdings: WalletHoldings) {
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
 * history entry, without claiming a transaction identity or emitting a notice. The snapshot update is compare-and-set, so
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
    // A balance delta has no transaction identity, sender or venue. Keep it as
    // history enrichment, never emit a second notice for a provider-announced trade.
    added += 1;
  }
  return added;
}


/** A balance increase carries no sender; the ledger says so plainly. */
const INBOUND_COUNTERPARTY = 'deposit (sender not indexed)';


/** Credit a swap's expected output to the snapshot so it is not read as a deposit. */
export async function creditSnapshot(
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
 * larger than what the asset holds moves nothing and posts a refusal notice. `agentId` (when present) is the agent that
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
    return delegationRefusal(database, { ownerIdentityId: identityId, workspaceId, binding }, agentId, input);
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

  let sent: { txId: string };
  try {
    sent = await source.sendTransaction(binding.eoaAddress, input);
  } catch (error) {
    return handleSendFailure(database, { ownerIdentityId: identityId, workspaceId, binding },
      agentId, error, input.asset, input.amount, input.chain, input.to);
  }
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
  }, { operation: 'send', ...(agentId ? { agentId } : {}) });
  return { outcome: 'sent', txUrl, amountText, balanceAfterUsd };
}


export async function agentName(database: SqlDatabase, agentId: string): Promise<string | null> {
  const row = (
    await database.query<{ name: string; handle: string | null }>(
      `SELECT name,handle FROM identities WHERE id=$1`,
      [agentId],
    )
  ).rows[0];
  return row?.handle ? systemMessage("wallet.agent-mention", row.handle) : (row?.name ?? null);
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


export async function recordTransaction(
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
 * silently in wallet history. Runs on wallet reads, so a
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
    // wallet_transactions retains incoming receipts without a System DM.
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
