import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import type { ConnectorOfferCardView } from '@beeline/api-contract/connector-offers';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { connectorDisplayName } from './workbench.js';
import { ensureSystemIdentity, identitySubject, connectorOfferDecisionLines } from './system-line.js';

type ConnectingOffer = {
  id: string;
  room_id: string;
  agent_id: string;
  command_id: string | null;
  connector_type: ConnectorOfferCardView['connectorType'];
  intent: ConnectorOfferCardView['intent'];
  accepted_by: string | null;
  accepted_at: Date;
  accepted_name: string;
  accepted_kind: 'human' | 'agent';
};

export type CompletedConnectorOffer = {
  readonly offerId: string;
  readonly roomId: string;
  readonly agentId: string;
};

/** Failure is a decision too: release the open-offer slot and resume the agent. */
export async function failConnectingOffers(
  database: SqlDatabase,
  target: { agentId: string; connectorId?: string } | { expired: true },
): Promise<CompletedConnectorOffer[]> {
  // Candidate discovery is bounded, but grants no transition authority. Keep
  // the existing agent -> connector -> offer lock order used by status reports.
  let expiredIds: string[] = [];
  if ('expired' in target) {
    expiredIds = (await database.query<{ id: string }>(
      `SELECT id FROM connector_offers WHERE status='connecting'
       AND COALESCE(accepted_at,created_at)<=now()-interval '15 minutes'
       ORDER BY COALESCE(accepted_at,created_at),id LIMIT 100`,
    )).rows.map(offer => offer.id);
    if (!expiredIds.length) return [];
    await database.query(`UPDATE squire_machines SET squire_work=(squire_work-'install'-'signIn') ||
      '{"errorMessage":"Connection timed out. Retry to continue."}'::jsonb
      WHERE squire_work->>'install'='true'
        AND COALESCE((squire_work->>'reportedAt')::double precision,0)<extract(epoch FROM now())-900
        AND EXISTS (SELECT 1 FROM connector_offers offer WHERE offer.id=ANY($1::uuid[])
          AND offer.agent_id=squire_machines.helper_agent_id AND offer.status='connecting'
          AND COALESCE(offer.accepted_at,offer.created_at)<=now()-interval '15 minutes')`, [expiredIds]);
    await database.query(`UPDATE workspace_connectors connector SET status='error',
      status_error='Connection timed out. Retry to continue.',sign_in=NULL,updated_at=now()
      WHERE connector.status='installing' AND connector.updated_at<now()-interval '15 minutes'
        AND EXISTS (SELECT 1 FROM connector_offers offer WHERE offer.id=ANY($1::uuid[])
          AND offer.connector_id=connector.id AND offer.status='connecting'
          AND COALESCE(offer.accepted_at,offer.created_at)<=now()-interval '15 minutes')`, [expiredIds]);
  }
  return settleConnectingOffers(database, 'expired' in target
    ? "offer.id=ANY($1::uuid[]) AND COALESCE(offer.accepted_at,offer.created_at)<=now()-interval '15 minutes'"
    : target.connectorId ? 'offer.connector_id=$1::uuid'
    : `offer.connector_type='trusty-squire' AND EXISTS (SELECT 1 FROM agents reporting
        JOIN agents offering ON offering.agent_id=offer.agent_id
        WHERE reporting.agent_id=$1 AND reporting.owner_id=offering.owner_id
          AND COALESCE(reporting.machine_id,reporting.agent_id)=offer.machine_id)`,
    'expired' in target ? [expiredIds] : target.connectorId ? [target.connectorId] : [target.agentId], 'failed');
}

/**
 * Settle every offer waiting on one connector row. The helper's connected
 * report is the boundary: before this function runs there is no decided line
 * and therefore no resume command for the paused agent.
 *
 * The caller owns the transaction that also marks the connector connected.
 */
export async function completeConnectorOffersForConnector(
  database: SqlDatabase,
  connectorId: string,
): Promise<CompletedConnectorOffer[]> {
  return settleConnectingOffers(database, 'offer.connector_id=$1::uuid', [connectorId], 'accepted', connectorId);
}

/**
 * Settle one wallet offer. Accepting it was the owner's own grant to sign, so
 * there is no connector row or helper report to wait on.
 */
export async function completeWalletConnectorOffer(
  database: SqlDatabase,
  offerId: string,
): Promise<CompletedConnectorOffer[]> {
  return settleConnectingOffers(database, 'offer.id=$1::uuid', [offerId], 'accepted');
}

/** Broker-backed sign-in completes offers on that owner's machine. */
export async function completeSquireMachineOffers(
  database: SqlDatabase, ownerId: string, machineId: string,
): Promise<CompletedConnectorOffer[]> {
  return settleConnectingOffers(database, `offer.connector_type='trusty-squire'
    AND (offer.accepted_by=$1 OR (offer.accepted_by IS NULL AND offer.addressee_id=$1))
    AND offer.machine_id=$2 AND NOT EXISTS (SELECT 1 FROM squire_machines pending
      WHERE pending.owner_id=$1 AND pending.machine_id=$2 AND pending.squire_work->>'install'='true')`,
    [ownerId,machineId], 'accepted', `squire:${machineId}`);
}

async function settleConnectingOffers(database: SqlDatabase, predicate: string, values: unknown[],
  status: 'accepted' | 'failed', connectorId?: string): Promise<CompletedConnectorOffer[]> {
  const offers = (await database.query<ConnectingOffer>(`WITH changed AS (
    UPDATE connector_offers offer SET status=$${values.length+1}
    WHERE offer.status='connecting' AND ${predicate} RETURNING offer.*
  ), cards AS (
    UPDATE messages message SET card=jsonb_set(message.card,'{status}',to_jsonb($${values.length+1}::text))
    FROM (SELECT DISTINCT ON (offer.id) message.id FROM changed offer
      JOIN messages message ON message.room_id=offer.room_id AND message.card_type='connector-offer'
        AND message.card->>'offerId'=offer.id::text
      ORDER BY offer.id,message.created_at DESC,message.id DESC) latest
    WHERE message.id=latest.id AND message.card->>'status'='connecting'
  ) SELECT offer.id,offer.room_id,offer.agent_id,offer.command_id,offer.connector_type,offer.intent,
      offer.accepted_by,offer.accepted_at,acceptor.name accepted_name,acceptor.kind accepted_kind
    FROM changed offer LEFT JOIN identities acceptor ON acceptor.id=offer.accepted_by
    ORDER BY offer.created_at,offer.id`, [...values,status])).rows;
  if (!offers.length) return [];
  if (status==='failed' || offers.some(offer => !offer.accepted_by)) await ensureSystemIdentity(database);
  await connectorOfferDecisionLines(database, offers.map(offer => {
    const connectorName=connectorDisplayName(offer.connector_type);
    const failure=status==='failed';
    return {
      roomId:offer.room_id,authorId:failure ? SYSTEM_IDENTITY_ID : offer.accepted_by ?? SYSTEM_IDENTITY_ID,
      subject:failure ? {kind:'system' as const,name:systemMessage('connector-offer-completion.connector-setup')}
        : offer.accepted_by ? identitySubject({id:offer.accepted_by,kind:offer.accepted_kind,name:offer.accepted_name})
        : {kind:'system' as const,name:connectorName},
      verb:failure ? systemMessage('connector-offer-completion.failed') : offer.accepted_by
        ? offer.intent==='reconnect' ? systemMessage('connector-offer-completion.reconnected') : systemMessage('connector-offer-completion.added')
        : systemMessage('connector-offer-completion.reconnected-automatically'),
      ...(failure ? {consequence:systemMessage('connector-offer-completion.retry-the-connection-to-continue')}
        : offer.accepted_by ? {object:connectorName} : {}),
      kind:'connector-offer-decided' as const,...(offer.command_id ? {commandId:offer.command_id} : {}),
      wakes:[offer.agent_id],cardType:'connector-offer-decision',
      card:{offerId:offer.id,status,...(connectorId ? {connectorId} : {})},
    };
  }));
  return offers.map(offer => ({offerId:offer.id,roomId:offer.room_id,agentId:offer.agent_id}));
}
