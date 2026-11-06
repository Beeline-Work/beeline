import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { createHash, randomBytes } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { WalletChainId } from '@beeline/api-contract/wallet';
import type { SqlDatabase } from './database.js';
import { ensureSystemDirectMessageRoom, restateSystemLine, systemLine } from './system-line.js';

export type WalletNotice = {
  walletNotice: true;
  status: 'submitted' | 'pending' | 'confirmed' | 'failed' | 'refused';
  operation: 'send' | 'swap' | 'contract' | 'transfer' | 'approval';
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
  const id = notice.txUrl ? walletNoticeId(ownerId,notice.chain,notice.txUrl) : randomBytes(32).toString('hex');
  await database.transaction(async tx => {
    const exists=(await tx.query('SELECT id FROM messages WHERE id=$1',[id])).rowCount;
    if (!exists) {
      const roomId=await ensureSystemDirectMessageRoom(tx,workspaceId,ownerId);
      await systemLine(tx,{...walletNoticePhrase(notice),id,roomId,authorId:SYSTEM_IDENTITY_ID,
        durableFact:notice.status==='failed'||notice.status==='refused'?'failure':'action',card:notice});
    }
    // SET evaluates the latest row after any competing updater commits.
    // An execution owns attribution; a terminal verdict cannot regress.
    const terminal="(card->>'status'='failed' OR (card->>'status'='confirmed' AND $2::jsonb->>'status' NOT IN ('confirmed','failed')))";
    const next=(await tx.query<{card:WalletNotice}>(`UPDATE messages SET card=
      ((card || $2::jsonb) - CASE WHEN ${terminal} AND NOT card ? 'reason' THEN ARRAY['reason'] ELSE '{}'::text[] END)
      || CASE WHEN card->>'execution'='true' AND $2::jsonb->>'execution' IS DISTINCT FROM 'true'
        THEN jsonb_build_object('operation',card->'operation','amountText',card->'amountText',
          'counterparty',card->'counterparty','execution',true) ELSE '{}'::jsonb END
      || CASE WHEN ${terminal} THEN jsonb_build_object('status',card->'status') ||
        CASE WHEN card ? 'reason' THEN jsonb_build_object('reason',card->'reason') ELSE '{}'::jsonb END ELSE '{}'::jsonb END
      || CASE WHEN card ? 'transfers' OR $2::jsonb ? 'transfers' THEN jsonb_build_object('transfers',
        COALESCE(card->'transfers','{}'::jsonb) || COALESCE($2::jsonb->'transfers','{}'::jsonb)) ELSE '{}'::jsonb END
      WHERE id=$1 RETURNING card`,[id,JSON.stringify(notice)])).rows[0]?.card;
    if (!next) return;
    if (next.transfers && !next.execution)
      next.amountText=Object.values(next.transfers).join(systemMessage('wallet-notices.detail-separator'));
    if (next.operation==='approval' && next.status==='confirmed')
      next.reason=systemMessage('wallet-notices.approval-confirmed-requires-new-action');
    await restateSystemLine(tx,id,walletNoticePhrase(next),next);
    if (next.status==='failed') await tx.query("UPDATE messages SET durable_fact='failure' WHERE id=$1",[id]);
  });
}

function walletNoticePhrase(next: WalletNotice) {
  const verb =
    next.status === 'failed' || next.status === 'refused'
      ? systemMessage("wallet-notices.could-not-complete")
      : next.status === 'pending' && !next.txUrl
        ? systemMessage("wallet-notices.could-not-confirm")
      : next.status === 'confirmed'
        ? systemMessage("wallet-notices.confirmed")
        : systemMessage("wallet-notices.submitted");
  const actor = next.agentName ?? (next.execution ? systemMessage("wallet-notices.you") : systemMessage("wallet-notices.initiator-not-known-to-beeline"));
  return {
    subject: { kind: 'system' as const, name: systemMessage("wallet-notices.wallet") },
    verb,
    object: {
      text: systemMessage("wallet-notices.on", next.operation, next.amountText, next.chain, next.counterparty),
      ...(next.txUrl ? { url: next.txUrl } : {}),
    },
    consequence: [
      actor,
      next.status === 'pending'
        ? next.txUrl ? systemMessage("wallet-notices.confirmation-pending") : systemMessage("wallet-notices.submission-outcome-unknown")
        : '',
      next.reason,
      next.balanceAfterUsd ? systemMessage("wallet-notices.left", next.balanceAfterUsd) : '',
    ]
      .filter(Boolean)
      .join(systemMessage("wallet-notices.separator")),
  };
}
