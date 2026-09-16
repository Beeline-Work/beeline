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
 *    funds. No caps, no approvals, no policy engine.
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
} from '@beeline/api-contract/wallet';
import {
  ensureConnectorDirectMessageRoom,
  ensureConnectorIdentity,
} from './workbench.js';
import { systemLine } from './system-line.js';
import { fakeCdpWalletSource } from './cdp-fake.js';
import { realCdpWalletSource, type CdpWalletSource } from './cdp-client.js';

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
    }>(
      `SELECT cdp_user_id,eoa_address,solana_address FROM wallet_bindings WHERE identity_id=$1`,
      [identityId],
    )
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
  const coins = await source.balances('base', binding.eoaAddress);
  const chains = [];
  for (const chain of ['base', 'arbitrum', 'optimism', 'polygon', 'zora', 'bnb', 'avalanche', 'ethereum'] as const) {
    const fee = await source.feeEstimate(chain);
    chains.push({
      id: chain,
      name: WALLET_CHAIN_NAMES[chain],
      ...(fee.feeUsd !== null ? { feeUsd: fee.feeUsd.toFixed(2) } : { feeUsd: null }),
      sponsored: fee.sponsored,
      // Every EVM chain spends the SAME EOA balance, so one holding lights
      // them all; the per-chain picker still shows the fee difference.
      hasBalance: coins.some((coin) => Number(coin.amount) > 0),
    });
  }
  const totalUsd = coins.reduce((sum, coin) => sum + usdValue(coin), 0);
  const sponsorship = await source.sponsorshipAllowance();
  return {
    address: binding.eoaAddress,
    solanaAddress: binding.solanaAddress,
    totalUsd: formatUsd(totalUsd),
    coins,
    chains,
    sponsorship: sponsorship
      ? {
          usedUsd: formatUsd(sponsorship.usedUsd),
          limitUsd: formatUsd(sponsorship.limitUsd),
        }
      : null,
    delegation: await delegationView(database, identityId),
  };
}

/** How long a delegated-signing grant stands, in hours. */
export const WALLET_DELEGATION_TTL_HOURS = Number(
  process.env.WALLET_DELEGATION_TTL_HOURS ?? 24,
);

export async function delegationView(
  database: SqlDatabase,
  identityId: string,
): Promise<{ active: boolean; expiresAt: number | null }> {
  const row = (
    await database.query<{ delegation_expires_at: Date | null }>(
      `SELECT delegation_expires_at FROM wallet_bindings WHERE identity_id=$1`,
      [identityId],
    )
  ).rows[0];
  const expiresAt = row?.delegation_expires_at ? row.delegation_expires_at.getTime() : null;
  return { active: expiresAt !== null && expiresAt > Date.now(), expiresAt };
}

/**
 * The user (present, on their phone) grants or renews the delegated-signing
 * grant. One user-scoped delegation is active at a time: granting overwrites
 * the previous expiry. A grant or renewal is announced in the @wallet thread
 * so the ledger shows WHY agents can spend.
 */
export async function grantWalletDelegation(
  database: SqlDatabase,
  identityId: string,
  workspaceId: string,
): Promise<{ expiresAt: number }> {
  const binding = await walletBinding(database, identityId);
  if (!binding) throw new Error('wallet not created');
  const expiresAt = Date.now() + WALLET_DELEGATION_TTL_HOURS * 3_600_000;
  await database.query(
    `UPDATE wallet_bindings SET delegation_expires_at=$2,updated_at=now() WHERE identity_id=$1`,
    [identityId, new Date(expiresAt)],
  );
  const connectorId = await ensureConnectorIdentity(database, 'wallet');
  const roomId = await ensureConnectorDirectMessageRoom(database, workspaceId, 'wallet', identityId);
  await systemLine(database, {
    roomId,
    authorId: connectorId,
    subject: { id: connectorId, kind: 'person', name: 'Wallet' },
    verb: 'granted',
    object: { text: 'agents permission to sign' },
    consequence: `until ${new Date(expiresAt).toISOString()}`,
    presentation: 'card',
    cardType: 'wallet-delegation',
    card: { expiresAt, ttlHours: WALLET_DELEGATION_TTL_HOURS },
  });
  return { expiresAt };
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
  const coins = await source.balances('base', binding.eoaAddress);
  const holding = coins.find((coin) => coin.symbol.toLowerCase() === input.asset.toLowerCase());
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
        (coin.symbol === holding.symbol ? usdValue(coin) * (1 - needed / available) : usdValue(coin)),
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
    const txId = createHash('sha256')
      .update(`${entry.txUrl}:${entry.createdAt}`)
      .digest('hex');
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
  return amountText.replace(/^[+\-−]/, '').replace(/\s*[A-Za-z]+$/, '').trim();
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
  const roomId = await ensureConnectorDirectMessageRoom(database, workspaceId, 'wallet', identityId);
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
  const roomId = await ensureConnectorDirectMessageRoom(database, workspaceId, 'wallet', identityId);
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
  op: 'state' | 'balance' | 'chains' | 'history' | 'quote' | 'pay' | 'swap',
  agentId: string,
  input?: { chain?: WalletChainId; limit?: number; asset?: string; amount?: string; fromAsset?: string; toAsset?: string; to?: string },
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
  switch (op) {
    case 'balance': {
      const coins = await source.balances('base', address);
      return {
        totalUsd: formatUsd(coins.reduce((sum, coin) => sum + usdValue(coin), 0)),
        coins,
      };
    }
    case 'chains': {
      const chains = [];
      for (const chain of WALLET_CHAIN_IDS) {
        const fee = await source.feeEstimate(chain);
        chains.push({
          id: chain,
          name: WALLET_CHAIN_NAMES[chain],
          ...(fee.feeUsd !== null ? { feeUsd: fee.feeUsd.toFixed(2) } : { feeUsd: null }),
          sponsored: fee.sponsored,
          hasBalance: true,
        });
      }
      return { chains };
    }
    case 'history':
      return { entries: await walletHistory(database, ctx.ownerIdentityId, input?.limit ?? 20) };
    case 'quote': {
      const fee = await source.feeEstimate((input?.chain ?? 'base') as WalletChainId);
      const coins = await source.balances('base', address);
      const symbol = (input?.asset ?? 'usdc').toLowerCase();
      const available = coins.find((coin) => coin.symbol === symbol)?.amount ?? '0';
      return {
        feeUsd: fee.feeUsd !== null ? fee.feeUsd.toFixed(2) : null,
        sponsored: fee.sponsored,
        sufficient: Number(available) >= Number(input?.amount ?? 0),
        available,
        asset: symbol,
      };
    }
    case 'pay': {
      return await agentSend(database, ctx, agentId, {
        chain: (input?.chain ?? 'base') as WalletChainId,
        asset: input?.asset ?? 'usdc',
        amount: input?.amount ?? '',
        to: input?.to ?? '',
      });
    }
    case 'swap': {
      if (!(await assertAgentDelegation(database, ctx.ownerIdentityId))) {
        return { outcome: 'delegation-expired' };
      }
      try {
        const swapped = await source.swap(address, {
          fromAsset: input?.fromAsset ?? 'usdc',
          toAsset: input?.toAsset ?? 'eth',
          amount: input?.amount ?? '',
        });
        const coins = await source.balances('base', address);
        const totalUsd = coins.reduce((sum, coin) => sum + usdValue(coin), 0);
        const fromAmountText = `−${input?.amount} ${(input?.fromAsset ?? 'usdc').toUpperCase()}`;
        const toAmountText = `+${swapped.toAmount} ${(input?.toAsset ?? 'eth').toUpperCase()}`;
        const txUrl = walletExplorerTxUrl((input?.chain ?? 'base') as WalletChainId, swapped.txId);
        await postLedgerLine(database, ctx.workspaceId, ctx.ownerIdentityId, {
          direction: 'out',
          agentName: await agentName(database, agentId),
          amountText: `${fromAmountText} ${toAmountText}`,
          counterparty: `swap ${(input?.fromAsset ?? 'usdc').toUpperCase()}→${(input?.toAsset ?? 'eth').toUpperCase()}`,
          chain: (input?.chain ?? 'base') as WalletChainId,
          balanceAfterUsd: formatUsd(totalUsd),
          txUrl,
          createdAt: Date.now(),
        });
        await recordTransaction(database, ctx.ownerIdentityId, {
          txId: swapped.txId,
          direction: 'out',
          asset: (input?.fromAsset ?? 'usdc').toLowerCase(),
          amount: input?.amount ?? '',
          counterparty: `swap→${(input?.toAsset ?? 'eth').toUpperCase()}`,
          chain: (input?.chain ?? 'base') as WalletChainId,
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
        return handleSendFailure(database, ctx, agentId, error, (input?.fromAsset ?? 'usdc').toLowerCase(), input?.amount ?? '');
      }
    }
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
  const coins = await source.balances('base', ctx.binding.eoaAddress);
  const symbol = input.asset.toLowerCase();
  const available = coins.find((coin) => coin.symbol === symbol)?.amount ?? '0';
  if (Number(input.amount) > Number(available)) {
    await postInsufficientNotice(
      database,
      ctx.ownerIdentityId,
      ctx.workspaceId,
      { chain: input.chain, asset: input.asset, amount: input.amount },
      { needed: input.amount, available, asset: symbol, agentName: await agentName(database, agentId) },
    );
    return { outcome: 'insufficient', asset: symbol, needed: input.amount, available };
  }
  try {
    const sent = await source.sendTransaction(ctx.binding.eoaAddress, input);
    const after = await source.balances('base', ctx.binding.eoaAddress);
    const totalUsd = after.reduce((sum, coin) => sum + usdValue(coin), 0);
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
    return handleSendFailure(database, ctx, agentId, error, symbol, input.amount);
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
): Promise<WalletSendOutcome> {
  const reason = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
  const connectorId = await ensureConnectorIdentity(database, 'wallet');
  const roomId = await ensureConnectorDirectMessageRoom(database, ctx.workspaceId, 'wallet', ctx.ownerIdentityId);
  const id = createHash('sha256')
    .update(`wallet-failed:${ctx.ownerIdentityId}:${asset}:${amount}:${reason}:${Math.floor(Date.now() / 60_000)}`)
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
      chain: 'base' as WalletChainId,
      reason,
    },
  });
  return { outcome: 'failed', reason };
}