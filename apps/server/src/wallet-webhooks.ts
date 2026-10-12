import { createHmac, timingSafeEqual } from 'node:crypto';
import { walletExplorerTxUrl, type WalletChainId } from '@beeline/api-contract/wallet';
import type { SqlDatabase } from './database.js';
import { EVM_CHAINS, formatUnits, isEvmAddress, rpc } from './evm-chain.js';
import { postWalletNotice, walletNoticeId, type WalletNotice } from './wallet-notices.js';

/** Multiple subscriptions have independent secrets; never accept a key supplied by the delivery. */
export function cdpWebhookSecretsFromEnv(): Readonly<Record<string, string>> | undefined {
  const raw = process.env.COINBASE_CDP_WEBHOOK_SECRETS;
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('COINBASE_CDP_WEBHOOK_SECRETS must be a JSON object');
  }
  const secrets = object(value);
  if (
    !secrets ||
    Object.entries(secrets).some(
      ([id, secret]) => !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || typeof secret !== 'string' || !secret,
    )
  )
    throw new Error('COINBASE_CDP_WEBHOOK_SECRETS must map receiver ids to nonempty secrets');
  return secrets as Record<string, string>;
}

type Headers = Record<string, string | string[] | undefined>;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;

/** Bind the event type as well as the raw body. Reject future/stale or malformed deliveries. */
export function verifyCdpWebhook(
  raw: Buffer,
  headers: Headers,
  secret: string,
  now = Date.now(),
): boolean {
  const signature = headers['x-hook0-signature'];
  if (typeof signature !== 'string' || !secret) return false;
  const parts = new Map(
    signature.split(',').map((part) => part.trim().split('=', 2) as [string, string]),
  );
  const timestamp = parts.get('t');
  const names = parts.get('h');
  const supplied = parts.get('v1');
  if (
    !timestamp ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !names ||
    !supplied ||
    !/^[a-f0-9]{64}$/i.test(supplied)
  )
    return false;
  const signedNames = names.split(' ');
  if (
    !signedNames.includes('x-event-type') ||
    !signedNames.includes('x-event-id') ||
    signedNames.some((name) => !/^[a-z0-9-]+$/.test(name) || typeof headers[name] !== 'string')
  )
    return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${names}.${signedNames.map((name) => headers[name]).join('.')}.`)
    .update(raw)
    .digest();
  return timingSafeEqual(expected, Buffer.from(supplied, 'hex'));
}

/** All reads happen because a signed provider event arrived; there is no timer or polling loop. */
export async function ingestWalletWebhook(
  database: SqlDatabase,
  raw: Buffer,
  headers: Headers,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!verifyCdpWebhook(raw, headers, secret, now)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return false;
  }
  const body = object(parsed);
  if (!body) return false;
  const event = headers['x-event-type'];
  if (typeof event !== 'string' || (body.type !== undefined && body.type !== event)) return false;
  const data = object(body.data) ?? body;
  const lifecycleStatus: Record<string, WalletNotice['status']> = {
    'wallet.transaction.broadcast': 'submitted',
    'wallet.transaction.pending': 'pending',
    'wallet.transaction.confirmed': 'confirmed',
    'wallet.transaction.failed': 'failed',
  };
  const activity = event === 'wallet.activity.multi';
  const status = activity
    ? 'confirmed'
    : Object.hasOwn(lifecycleStatus, event)
      ? lifecycleStatus[event]
      : undefined;
  if (!status) return true; // Signing/creation are not evidence of an on-chain transfer.
  const network = data.network;
  const chain = Object.keys(EVM_CHAINS).find(
    (key) => key === network || `${key}-mainnet` === network,
  ) as WalletChainId | undefined;
  // This server only binds mainnet accounts; never mistake a testnet event for real money.
  if (!chain || (activity && chain !== 'base')) return true;
  const hash = activity ? data.transactionHash : data.transaction_hash;
  if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) return false;
  const addresses = activity ? [data.from, data.to] : [data.address];
  if (addresses.some((address) => typeof address !== 'string' || !isEvmAddress(address)))
    return false;
  const bindings = (
    await database.query<{ identity_id: string; workspace_id: string; eoa_address: string }>(
      `SELECT binding.identity_id,binding.eoa_address,current_workspace.workspace_id
     FROM wallet_bindings binding
     JOIN LATERAL (SELECT membership.workspace_id FROM memberships membership
       WHERE membership.identity_id=binding.identity_id AND membership.room_id IS NULL
         AND membership.removed_at IS NULL
       ORDER BY (membership.workspace_id=binding.workspace_id) DESC,membership.workspace_id
       LIMIT 1) current_workspace ON true
     WHERE lower(binding.eoa_address)=ANY($1::text[])`,
      [addresses.map((address) => (address as string).toLowerCase())],
    )
  ).rows;
  if (!bindings.length) return true;
  const txUrl = walletExplorerTxUrl(chain, hash);
  for (const binding of bindings) {
    const previous = (
      await database.query<{ card: WalletNotice }>(`SELECT card FROM messages WHERE id=$1`, [
        walletNoticeId(binding.identity_id, chain, txUrl),
      ])
    ).rows[0]?.card;
    let notice: WalletNotice;
    if (activity) {
      if (
        typeof data.contractAddress !== 'string' ||
        !isEvmAddress(data.contractAddress) ||
        typeof data.value !== 'string' ||
        !/^\d{1,78}$/.test(data.value) ||
        !Number.isSafeInteger(data.logIndex) ||
        Number(data.logIndex) < 0
      )
        return false;
      const usdc =
        data.contractAddress.toLowerCase() === EVM_CHAINS.base.usdc.address.toLowerCase();
      const amount = usdc
        ? `${formatUnits(BigInt(data.value), 6)} USDC`
        : `${data.value} raw units of token ${data.contractAddress}`;
      const outgoing = (data.from as string).toLowerCase() === binding.eoa_address.toLowerCase();
      const counterparty = String(outgoing ? data.to : data.from);
      const transfer = `${outgoing ? '−' : '+'}${amount} ${outgoing ? 'to' : 'from'} ${counterparty}`;
      notice = {
        walletNotice: true,
        status,
        operation: 'transfer',
        chain,
        txUrl,
        amountText: transfer,
        counterparty: 'Base ERC-20 transfer',
        transfers: { [String(data.logIndex)]: transfer },
      };
    } else if (previous) {
      notice = { ...previous, status };
    } else {
      // Wallet lifecycle payloads only contain the hash/account. Enrich once from that transaction.
      // A missing transaction is retryable (non-2xx); do not acknowledge away its amount/venue.
      const tx = object(
        await rpc(chain, 'eth_getTransactionByHash', [hash], AbortSignal.timeout(10_000)),
      );
      if (
        !tx ||
        typeof tx.from !== 'string' ||
        tx.from.toLowerCase() !== binding.eoa_address.toLowerCase() ||
        typeof tx.to !== 'string' ||
        !isEvmAddress(tx.to) ||
        typeof tx.value !== 'string' ||
        !/^0x[0-9a-f]{1,64}$/i.test(tx.value)
      )
        throw new Error('wallet webhook transaction not available');
      const input = typeof tx.input === 'string' ? tx.input : '0x';
      const transfer =
        tx.to.toLowerCase() === EVM_CHAINS[chain].usdc.address.toLowerCase() &&
        /^0xa9059cbb[0-9a-f]{128}$/i.test(input);
      notice = {
        walletNotice: true,
        status,
        chain,
        txUrl,
        operation: transfer || input === '0x' ? 'send' : 'contract',
        amountText: transfer
          ? `${formatUnits(BigInt(`0x${input.slice(74, 138)}`), EVM_CHAINS[chain].usdc.decimals)} USDC`
          : `${formatUnits(BigInt(tx.value), 18)} ${EVM_CHAINS[chain].nativeSymbol.toUpperCase()}${input !== '0x' ? ' native value (token amounts not indexed)' : ''}`,
        counterparty: transfer ? `0x${input.slice(34, 74)}` : tx.to,
        ...(!transfer && BigInt(tx.value) > 0n
          ? {
              nativeAmountText: `${formatUnits(BigInt(tx.value), 18)} ${EVM_CHAINS[chain].nativeSymbol.toUpperCase()}`,
            }
          : {}),
      };
    }
    if (
      !notice.execution &&
      !notice.receiptIndexed &&
      notice.operation === 'contract' &&
      status === 'confirmed'
    ) {
      // A trade's token legs live in its receipt, not in the native transaction value.
      const receipt = object(
        await rpc(chain, 'eth_getTransactionReceipt', [hash], AbortSignal.timeout(10_000)),
      );
      if (!receipt || !Array.isArray(receipt.logs))
        throw new Error('wallet webhook receipt not available');
      const transfers: Record<string, string> = {};
      for (const value of receipt.logs) {
        const log = object(value);
        if (
          !log ||
          typeof log.address !== 'string' ||
          !isEvmAddress(log.address) ||
          !Array.isArray(log.topics) ||
          log.topics.length !== 3 ||
          String(log.topics[0]).toLowerCase() !==
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' ||
          !log.topics
            .slice(1)
            .every((topic) => typeof topic === 'string' && /^0x[0-9a-f]{64}$/i.test(topic)) ||
          typeof log.data !== 'string' ||
          !/^0x[0-9a-f]{64}$/i.test(log.data) ||
          typeof log.logIndex !== 'string' ||
          !/^0x[0-9a-f]{1,8}$/i.test(log.logIndex)
        )
          continue;
        const from = `0x${String(log.topics[1]).slice(-40)}`;
        const to = `0x${String(log.topics[2]).slice(-40)}`;
        const outgoing = from.toLowerCase() === binding.eoa_address.toLowerCase();
        if (!outgoing && to.toLowerCase() !== binding.eoa_address.toLowerCase()) continue;
        const usdc = log.address.toLowerCase() === EVM_CHAINS[chain].usdc.address.toLowerCase();
        const amount = usdc
          ? `${formatUnits(BigInt(log.data), EVM_CHAINS[chain].usdc.decimals)} USDC`
          : `${BigInt(log.data)} raw units of token ${log.address}`;
        transfers[String(Number.parseInt(log.logIndex, 16))] =
          `${outgoing ? '−' : '+'}${amount} ${outgoing ? 'to' : 'from'} ${outgoing ? to : from}`;
      }
      if (Object.keys(transfers).length) {
        if (notice.nativeAmountText) {
          transfers.native = `−${notice.nativeAmountText} to ${notice.counterparty}`;
        }
        notice.transfers = transfers;
        const values = Object.values(transfers);
        if (
          values.some((value) => value.startsWith('−')) &&
          values.some((value) => value.startsWith('+'))
        )
          notice.operation = 'swap';
      }
      notice.receiptIndexed = true;
    }
    if (status === 'failed') notice.reason = 'provider reported transaction failure';
    await postWalletNotice(database, binding.workspace_id, binding.identity_id, notice);
  }
  return true;
}
