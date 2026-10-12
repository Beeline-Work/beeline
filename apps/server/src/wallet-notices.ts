import { createHash, randomBytes } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { WalletChainId } from '@beeline/api-contract/wallet';
import type { SqlDatabase } from './database.js';
import { ensureSystemDirectMessageRoom, restateSystemLine, systemLine } from './system-line.js';

export type WalletNotice = {
  walletNotice: true;
  status: 'submitted' | 'pending' | 'confirmed' | 'failed' | 'refused';
  operation: 'send' | 'swap' | 'contract' | 'transfer';
  amountText: string;
  counterparty: string;
  chain: WalletChainId;
  txUrl?: string;
  agentId?: string;
  agentName?: string | null;
  balanceAfterUsd?: string;
  reason?: string;
  /** Execution knows the initiator and intended spends; a provider cannot infer either. */
  execution?: boolean;
  transfers?: Record<string, string>;
  nativeAmountText?: string;
  receiptIndexed?: boolean;
};

export function walletNoticeId(ownerId: string, chain: WalletChainId, txUrl: string): string {
  return createHash('sha256').update(`wallet-notice:${ownerId}:${chain}:${txUrl}`).digest('hex');
}

/** One row per owner/chain/transaction, including provider retries and settlement. */
export async function postWalletNotice(
  database: SqlDatabase,
  workspaceId: string,
  ownerId: string,
  notice: WalletNotice,
): Promise<void> {
  const id = notice.txUrl
    ? walletNoticeId(ownerId, notice.chain, notice.txUrl)
    : randomBytes(32).toString('hex');
  await database.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`wallet-notice:${id}`]);
    const previous = (
      await tx.query<{ card: WalletNotice }>(`SELECT card FROM messages WHERE id=$1`, [id])
    ).rows[0]?.card;
    const terminal = (status: WalletNotice['status']) =>
      status === 'confirmed' || status === 'failed';
    const next: WalletNotice = {
      ...previous,
      ...notice,
      ...(previous?.execution && !notice.execution
        ? {
            operation: previous.operation,
            amountText: previous.amountText,
            counterparty: previous.counterparty,
            execution: true,
          }
        : {}),
      ...(previous && terminal(previous.status) && !terminal(notice.status)
        ? { status: previous.status, reason: previous.reason }
        : {}),
      ...(previous?.status === 'failed' ? { status: 'failed', reason: previous.reason } : {}),
    };
    if (previous?.transfers || notice.transfers) {
      next.transfers = { ...previous?.transfers, ...notice.transfers };
      if (!next.execution) next.amountText = Object.values(next.transfers).join('; ');
    }
    const verb =
      next.status === 'failed' || next.status === 'refused'
        ? 'could not complete'
        : next.status === 'confirmed'
          ? 'confirmed'
          : 'submitted';
    const actor = next.agentName ?? (next.execution ? 'you' : 'initiator not known to Beeline');
    const phrase = {
      subject: { kind: 'system' as const, name: 'Wallet' },
      verb,
      object: {
        text: `${next.operation} ${next.amountText} on ${next.chain} · ${next.counterparty}`,
        ...(next.txUrl ? { url: next.txUrl } : {}),
      },
      consequence: [
        actor,
        next.status === 'pending' ? 'confirmation pending' : '',
        next.reason,
        next.balanceAfterUsd ? `${next.balanceAfterUsd} left` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    };
    if (previous) {
      await restateSystemLine(tx, id, phrase, next);
      if (next.status === 'failed')
        await tx.query(`UPDATE messages SET durable_fact='failure' WHERE id=$1`, [id]);
    } else {
      const roomId = await ensureSystemDirectMessageRoom(tx, workspaceId, ownerId);
      await systemLine(tx, {
        ...phrase,
        id,
        roomId,
        authorId: SYSTEM_IDENTITY_ID,
        durableFact: next.status === 'failed' || next.status === 'refused' ? 'failure' : 'action',
        // Ordinary system rows qualify for DM push and use the linked system-line renderer.
        card: next,
      });
    }
  });
}
