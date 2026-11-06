import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { walletExplorerTxUrl, isWalletChainId, type WalletChainId, type WalletContractCall, type WalletLedgerEntry, type WalletSendInput, type WalletSendOutcome, type WalletTypedData, type WalletSignTypedDataResult } from '@beeline/api-contract/wallet';
import { ensureSystemDirectMessageRoom } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { systemLine } from './system-line.js';
import { postWalletNotice, type WalletNotice } from './wallet-notices.js';
import { WalletTransactionPending, type CdpWalletSource } from './cdp-client.js';
import { EVM_CHAINS, evmAsset, formatUnits, isEvmAddress, parseUnits } from './evm-chain.js';
import { venueRefusal, type WalletTransfer } from './wallet-venues.js';
import { agentName, WalletBinding, walletBinding, walletSource, WalletHoldings, readHoldings, formatUsd, holdingsUsd, chainViews, walletHistory, chainCoins, assertAgentDelegation, creditSnapshot, recordTransaction, reconcileBalances, usdValue } from './wallet.js';



/** One owner-only @System notice, shared with provider settlement events. */
export async function postLedgerLine(
  database: SqlDatabase,
  workspaceId: string,
  identityId: string,
  entry: WalletLedgerEntry,
  detail: Partial<Pick<WalletNotice, 'status' | 'operation' | 'agentId'>> = {},
): Promise<void> {
  await postWalletNotice(database, workspaceId, identityId, {
    walletNotice: true,
    status: entry.direction === 'in' ? 'confirmed' : 'submitted',
    operation: 'transfer',
    amountText: entry.amountText,
    counterparty: entry.counterparty,
    chain: entry.chain,
    balanceAfterUsd: entry.balanceAfterUsd,
    agentName: entry.agentName,
    ...(entry.txUrl ? { txUrl: entry.txUrl } : {}),
    execution: entry.direction === 'out',
    ...detail,
  });
}


/** Each refused attempt is a notice; retries of a provider transaction share its hash. */
export async function postInsufficientNotice(
  database: SqlDatabase,
  identityId: string,
  workspaceId: string,
  input: { chain: WalletChainId; asset: string; amount: string; to?: string },
  detail: { needed: string; available: string; asset: string; agentName: string | null },
): Promise<void> {
  await postWalletNotice(database, workspaceId, identityId, {
    walletNotice: true, status: 'refused', operation: 'send', execution: true,
    amountText: `${input.amount} ${input.asset.toUpperCase()}`,
    counterparty: input.to ?? 'wallet operation', chain: input.chain,
    agentName: detail.agentName,
    reason: `not enough funds (${detail.available} ${detail.asset} available)`,
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
    | 'swap',
  agentId: string,
  input?: {
    completionV1?: true;
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
        ...(input?.completionV1 === true ? { completionV1: true } : {}),
        chain: validChain(chain),
        asset: input?.asset ?? 'usdc',
        amount: input?.amount ?? '',
        to: input?.to ?? '',
      });
    }
    case 'swap': {
      const swapChain = validChain(chain);
      const fromAsset = (input?.fromAsset ?? 'usdc').toLowerCase();
      const toAsset = (input?.toAsset ?? 'eth').toLowerCase();
      const amount = input?.amount ?? '';
      const venue = `Coinbase CDP swap ${fromAsset.toUpperCase()}→${toAsset.toUpperCase()}`;
      if (!(await assertAgentDelegation(database, ctx.ownerIdentityId)))
        return delegationRefusal(database, ctx, agentId,
          { chain: swapChain, asset: fromAsset, amount, to: venue }, 'swap');
      let before: WalletHoldings;
      let swapped: Awaited<ReturnType<CdpWalletSource['swap']>>;
      try {
        before = await holdings();
        swapped = await source.swap(address, {
          chain: swapChain, fromAsset, toAsset, amount,
          ...(input?.completionV1 === true ? { completionV1: true } : {}),
        });
      } catch (error) {
        return handleSendFailure(database, ctx, agentId, error, fromAsset, amount, swapChain, venue, 'swap');
      }
      if (swapped.status === 'pending') {
        await postWalletNotice(database, ctx.workspaceId, ctx.ownerIdentityId, {
          walletNotice: true, status: 'pending', operation: 'swap', execution: true,
          amountText: `${amount} ${fromAsset.toUpperCase()}→${toAsset.toUpperCase()}`,
          counterparty: venue, chain: swapChain, agentId,
          agentName: await agentName(database, agentId),
          txUrl: walletExplorerTxUrl(swapChain, swapped.txId),
        });
        return {
          outcome: 'pending',
          txUrl: walletExplorerTxUrl(swapChain, swapped.txId),
          reason: 'Swap submitted; confirmation is pending. Do not resubmit this intent.',
        };
      }
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
        counterparty: venue,
        chain: swapChain,
        balanceAfterUsd: formatUsd(totalUsd),
        txUrl,
        createdAt: Date.now(),
      }, { operation: 'swap', status: 'confirmed', agentId });
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
    }
  }
}


function validChain(chain: unknown): WalletChainId {
  if (!isWalletChainId(chain)) throw new Error(`unknown chain: ${String(chain)}`);
  return chain;
}


/** A failed snapshot reconciliation never blocks a balance read or a send. */
export async function reconcileBalancesSafely(
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
    return delegationRefusal(database, ctx, agentId, input);
  }
  const refusal = venueRefusal(input);
  if (refusal) return handleSendFailure(database, ctx, agentId, refusal, input.asset, input.amount, input.chain, input.to);
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
      input,
      {
        needed: input.amount,
        available,
        asset: symbol,
        agentName: await agentName(database, agentId),
      },
    );
    return { outcome: 'insufficient', asset: symbol, needed: input.amount, available };
  }
  let sent: { txId: string };
  try {
    sent = await source.sendTransaction(ctx.binding.eoaAddress, input);
  } catch (error) {
    return handleSendFailure(database, ctx, agentId, error, symbol, input.amount, input.chain, input.to);
  }
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
  }, { operation: 'send', agentId });
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
}


/** Calldata selectors that grant a token allowance; `approve` is the bounded way. */
const ALLOWANCE_SELECTORS = new Set([
  '0x095ea7b3', // approve(address,uint256)
  '0x39509351', // increaseAllowance(address,uint256)
  '0xa22cb465', // setApprovalForAll(address,bool)
]);

const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';


/**
 * Validate a contract call and list what it spends: the native value, the
 * approved token amount, and a USDC `transfer` encoded in the call data.
 * Throws a reason when the call is malformed or grants an allowance itself.
 */
export function contractCallSpends(input: WalletContractCall): {
  call: WalletContractCall;
  spends: WalletTransfer[];
} {
  const chain = validChain(input.chain);
  const contract = typeof input.contract === 'string' ? input.contract : '';
  if (!isEvmAddress(contract)) throw new Error(`invalid contract address: ${contract}`);
  const data = typeof input.data === 'string' ? input.data : '';
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data) || data.length > 2 + 2 * 64 * 1024)
    throw new Error('call data must be 0x-prefixed hex bytes, at most 64 KB');
  const selector = data.slice(0, 10).toLowerCase();
  if (ALLOWANCE_SELECTORS.has(selector))
    throw new Error('call data grants a token allowance; use approve, which approves an exact amount');
  const spends: WalletTransfer[] = [];
  const native = evmAsset(chain, 'native');
  let value: string | undefined;
  if (input.value !== undefined && input.value !== '') {
    value = String(input.value);
    if (parseUnits(value, native.decimals) > 0n)
      spends.push({ chain, asset: native.symbol, amount: value, to: contract });
  }
  let approve: WalletContractCall['approve'];
  if (input.approve !== undefined) {
    const asset = evmAsset(chain, String(input.approve?.asset ?? ''));
    if (!asset.token) throw new Error('approve needs a token, not the native asset');
    const amount = String(input.approve?.amount ?? '');
    if (parseUnits(amount, asset.decimals) <= 0n) throw new Error('approve amount must be positive');
    approve = { asset: asset.symbol, amount };
    spends.push({ chain, asset: asset.symbol, amount, to: contract });
  }
  const usdc = EVM_CHAINS[chain].usdc;
  if (
    selector === ERC20_TRANSFER_SELECTOR &&
    contract.toLowerCase() === usdc.address.toLowerCase() &&
    data.length === 10 + 128
  )
    spends.push({
      chain,
      asset: 'usdc',
      amount: formatUnits(BigInt(`0x${data.slice(74, 138)}`), usdc.decimals),
      to: `0x${data.slice(34, 74)}`,
    });
  return {
    call: {
      chain, contract, data, ...(value ? { value } : {}), ...(approve ? { approve } : {}),
      ...(input.completionV1 === true ? { completionV1: true } : {}),
    },
    spends,
  };
}


/**
 * One agent-initiated contract call (`wallet_contract_call`): the same
 * delegation gate, venue rules, funds check, ledger line and record as
 * `wallet_pay`. Its spends are the native value, the exact approval and a
 * USDC transfer in the call data.
 */
export async function agentContractCall(
  database: SqlDatabase,
  agentId: string,
  input: WalletContractCall,
): Promise<WalletSendOutcome> {
  const ctx = await walletAgentContext(database, agentId);
  if (!ctx) throw new Error('no wallet: the agent has no connected owner with a wallet');
  if (!(await assertAgentDelegation(database, ctx.ownerIdentityId)))
    return delegationRefusal(database, ctx, agentId,
      { chain: input.chain, asset: input.approve?.asset ?? 'native', amount: input.approve?.amount ?? input.value ?? '0', to: input.contract }, 'contract');
  let checked: ReturnType<typeof contractCallSpends>;
  try {
    checked = contractCallSpends(input);
  } catch (error) {
    return handleSendFailure(database, ctx, agentId, error,
      input.approve?.asset ?? 'native', input.approve?.amount ?? input.value ?? '0',
      input.chain, input.contract, 'contract');
  }
  const { call, spends } = checked;
  for (const spend of spends) {
    const refusal = venueRefusal(spend);
    if (refusal) return handleSendFailure(database, ctx, agentId, refusal, spend.asset, spend.amount, call.chain, spend.to, 'contract');
  }
  const source = walletSource();
  const holdings = await readHoldings(source, ctx.binding.eoaAddress);
  await reconcileBalancesSafely(database, ctx, holdings);
  const coins = chainCoins(holdings, call.chain);
  const needed = new Map<string, number>();
  for (const spend of spends)
    needed.set(spend.asset, (needed.get(spend.asset) ?? 0) + Number(spend.amount));
  for (const [symbol, amount] of needed) {
    const available = coins.find((coin) => coin.symbol === symbol)?.amount ?? '0';
    if (amount > Number(available)) {
      await postInsufficientNotice(
        database,
        ctx.ownerIdentityId,
        ctx.workspaceId,
        { chain: call.chain, asset: symbol, amount: String(amount), to: call.contract },
        {
          needed: String(amount),
          available,
          asset: symbol,
          agentName: await agentName(database, agentId),
        },
      );
      return { outcome: 'insufficient', asset: symbol, needed: String(amount), available };
    }
  }
  const primary = spends[0] ?? {
    chain: call.chain,
    asset: EVM_CHAINS[call.chain].nativeSymbol,
    amount: '0',
    to: call.contract,
  };
  let sent: { txId: string };
  try {
    sent = await source.contractCall(ctx.binding.eoaAddress, call);
  } catch (error) {
    return handleSendFailure(database, ctx, agentId, error, primary.asset, primary.amount, call.chain, call.contract, 'contract');
  }
  let totalUsd = holdingsUsd(holdings.coins);
  for (const [symbol, amount] of needed) {
    const holding = coins.find((coin) => coin.symbol === symbol);
    if (holding) totalUsd -= usdValue(holding) * (amount / Number(holding.amount));
  }
  const amountText = (spends.length ? spends : [primary])
    .map((spend) => `−${spend.amount} ${spend.asset.toUpperCase()}`)
    .join(' ');
  const txUrl = walletExplorerTxUrl(call.chain, sent.txId);
  await postLedgerLine(database, ctx.workspaceId, ctx.ownerIdentityId, {
    direction: 'out',
    agentName: await agentName(database, agentId),
    amountText,
    counterparty: call.contract,
    chain: call.chain,
    balanceAfterUsd: formatUsd(totalUsd),
    createdAt: Date.now(),
    txUrl,
  }, { operation: 'contract', agentId });
  await recordTransaction(database, ctx.ownerIdentityId, {
    txId: sent.txId,
    direction: 'out',
    asset: primary.asset,
    amount: primary.amount,
    counterparty: call.contract,
    chain: call.chain,
    balanceAfterUsd: formatUsd(totalUsd),
    txUrl,
    agentId,
  });
  return { outcome: 'sent', txUrl, amountText, balanceAfterUsd: formatUsd(totalUsd) };
}


/** Failures and refusals use the same owner-only path as successful sends. */
export async function handleSendFailure(
  database: SqlDatabase,
  ctx: WalletAgentContext,
  agentId: string | undefined,
  error: unknown,
  asset: string,
  amount: string,
  chain: WalletChainId,
  counterparty = 'wallet operation',
  operation: WalletNotice['operation'] = 'send',
): Promise<WalletSendOutcome> {
  if (error instanceof WalletTransactionPending) {
    const txUrl = error.txId ? walletExplorerTxUrl(chain, error.txId) : undefined;
    await postWalletNotice(database, ctx.workspaceId, ctx.ownerIdentityId, {
      walletNotice: true, status: 'pending', execution: true,
      operation: error.approval ? 'approval' : operation,
      amountText: error.approval
        ? `${error.approval.amount} ${error.approval.asset.toUpperCase()}`
        : `${amount} ${asset.toUpperCase()}`,
      counterparty: error.approval?.spender ?? counterparty,
      chain, reason: error.message,
      ...(txUrl ? { txUrl } : {}),
      ...(agentId ? { agentId, agentName: await agentName(database, agentId) } : {}),
    });
    return { outcome: 'pending', reason: error.message, ...(txUrl ? { txUrl } : {}) };
  }
  const reason = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
  // A reverted receipt already has a hash; link the failed on-chain attempt too.
  const hash = reason.match(/transaction (0x[0-9a-fA-F]{64}) (?:reverted|was not mined)/)?.[1];
  await postWalletNotice(database, ctx.workspaceId, ctx.ownerIdentityId, {
    walletNotice: true, status: 'failed', operation, execution: true,
    amountText: `${amount} ${asset.toUpperCase()}`, counterparty, chain, reason,
    ...(hash ? { txUrl: walletExplorerTxUrl(chain, hash) } : {}),
    ...(agentId ? { agentId, agentName: await agentName(database, agentId) } : {}),
  });
  return { outcome: 'failed', reason };
}


export async function delegationRefusal(
  database: SqlDatabase, ctx: WalletAgentContext, agentId: string,
  input: { chain: WalletChainId; asset: string; amount: string; to: string },
  operation: WalletNotice['operation'] = 'send',
): Promise<{ outcome: 'delegation-expired' }> {
  await handleSendFailure(database, ctx, agentId, 'signing delegation is inactive',
    input.asset, input.amount, input.chain, input.to, operation);
  return { outcome: 'delegation-expired' };
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
  const roomId = await ensureSystemDirectMessageRoom(database, ctx.workspaceId, ctx.ownerIdentityId);
  // This is an authorization audit, not an on-chain transaction. Never store
  // the reusable signature in a ledger card or manufacture a transfer amount.
  await systemLine(database, {
    roomId,
    authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'system', name: systemMessage("wallet.wallet") },
    verb: systemMessage("wallet.signed"),
    object: { text: systemMessage("wallet.eip-712-typed-data") },
    consequence: (await agentName(database, agentId)) ?? systemMessage("wallet.an-agent"),
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
