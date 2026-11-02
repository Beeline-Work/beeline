import type { ConnectorOfferCardView } from '@beeline/api-contract/connector-offers';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { connectorDisplayName } from './workbench.js';
import { ensureSystemIdentity, identitySubject, systemLine } from './system-line.js';

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
  if ('expired' in target) {
    await database.query(`UPDATE agents SET squire_work=(squire_work-'install'-'signIn') ||
      '{"errorMessage":"Connection timed out. Retry to continue."}'::jsonb
      WHERE squire_work->>'install'='true'
        AND COALESCE((squire_work->>'reportedAt')::double precision,0)<extract(epoch FROM now())-900
        AND EXISTS (SELECT 1 FROM connector_offers offer WHERE offer.agent_id=agents.agent_id
          AND offer.status='connecting' AND COALESCE(offer.accepted_at,offer.created_at)<now()-interval '15 minutes')`);
    await database.query(`UPDATE workspace_connectors connector SET status='error',
      status_error='Connection timed out. Retry to continue.',sign_in=NULL,updated_at=now()
      WHERE connector.status='installing' AND connector.updated_at<now()-interval '15 minutes'
        AND EXISTS (SELECT 1 FROM connector_offers offer WHERE offer.connector_id=connector.id
          AND offer.status='connecting' AND COALESCE(offer.accepted_at,offer.created_at)<now()-interval '15 minutes')`);
  }
  const offers = (await database.query<{ id: string; room_id: string; agent_id: string; command_id: string | null }>(
    `SELECT offer.id,offer.room_id,offer.agent_id,offer.command_id FROM connector_offers offer
     WHERE offer.status='connecting' AND ${'expired' in target
       ? "COALESCE(offer.accepted_at,offer.created_at)<now()-interval '15 minutes'"
       : target.connectorId
         ? 'offer.connector_id=$1::uuid'
         : `offer.connector_type='trusty-squire' AND EXISTS (SELECT 1 FROM agents reporting
             JOIN agents offering ON offering.agent_id=offer.agent_id
             WHERE reporting.agent_id=$1 AND reporting.owner_id=offering.owner_id
               AND COALESCE(reporting.machine_id,reporting.agent_id)=offer.machine_id)`}
     ORDER BY offer.created_at LIMIT 100 FOR UPDATE OF offer`,
    'expired' in target ? [] : target.connectorId ? [target.connectorId] : [target.agentId],
  )).rows;
  const result: CompletedConnectorOffer[] = [];
  for (const offer of offers) {
    await database.query(`UPDATE connector_offers SET status='failed' WHERE id=$1`, [offer.id]);
    await database.query(`UPDATE messages SET card=jsonb_set(card,'{status}','"failed"'::jsonb)
      WHERE room_id=$1 AND card_type='connector-offer' AND card->>'offerId'=$2
        AND card->>'status'='connecting'`, [offer.room_id, offer.id]);
    await ensureSystemIdentity(database);
    await systemLine(database, { roomId: offer.room_id, authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'system', name: 'Connector setup' }, verb: 'failed',
      consequence: 'Retry the connection to continue', kind: 'connector-offer-decided',
      ...(offer.command_id ? { commandId: offer.command_id } : {}), wakes: [offer.agent_id],
      cardType: 'connector-offer-decision', card: { offerId: offer.id, status: 'failed' } });
    result.push({ offerId: offer.id, roomId: offer.room_id, agentId: offer.agent_id });
  }
  return result;
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
  return settleConnectingOffers(database, 'offer.connector_id', connectorId, connectorId);
}

/**
 * Settle one wallet offer. Accepting it was the owner's own grant to sign, so
 * there is no connector row or helper report to wait on.
 */
export async function completeWalletConnectorOffer(
  database: SqlDatabase,
  offerId: string,
): Promise<CompletedConnectorOffer[]> {
  return settleConnectingOffers(database, 'offer.id', offerId);
}

/** Broker-backed sign-in completes offers on that owner's machine. */
export async function completeSquireMachineOffers(
  database: SqlDatabase, ownerId: string, machineId: string,
): Promise<CompletedConnectorOffer[]> {
  const offers = (await database.query<{ id: string }>(
    `SELECT id FROM connector_offers WHERE connector_type='trusty-squire'
       AND (accepted_by=$1 OR (accepted_by IS NULL AND addressee_id=$1)) AND machine_id=$2 AND status='connecting'
       AND NOT EXISTS (SELECT 1 FROM agents pending WHERE pending.owner_id=$1
         AND COALESCE(pending.machine_id,pending.agent_id)=$2
         AND pending.squire_work->>'install'='true')`, [ownerId, machineId],
  )).rows;
  const completed: CompletedConnectorOffer[] = [];
  for (const offer of offers)
    completed.push(...await settleConnectingOffers(database, 'offer.id', offer.id, `squire:${machineId}`));
  return completed;
}

async function settleConnectingOffers(
  database: SqlDatabase,
  key: 'offer.connector_id' | 'offer.id',
  value: string,
  connectorId?: string,
): Promise<CompletedConnectorOffer[]> {
  const offers = (
    await database.query<ConnectingOffer>(
      `SELECT offer.id,offer.room_id,offer.agent_id,offer.command_id,offer.connector_type,offer.intent,
              offer.accepted_by,offer.accepted_at,
              acceptor.name accepted_name,acceptor.kind accepted_kind
         FROM connector_offers offer
         LEFT JOIN identities acceptor ON acceptor.id=offer.accepted_by
        WHERE ${key}=$1::uuid AND offer.status='connecting'
        ORDER BY offer.created_at,offer.id
        FOR UPDATE OF offer`,
      [value],
    )
  ).rows;

  const completed: CompletedConnectorOffer[] = [];
  for (const offer of offers) {
    const updated = await database.query(
      `UPDATE connector_offers SET status='accepted'
        WHERE id=$1::uuid AND status='connecting'`,
      [offer.id],
    );
    if (!updated.rowCount) continue;

    const card = (
      await database.query<{ id: string; card: ConnectorOfferCardView }>(
        `SELECT id,card FROM messages
          WHERE room_id=$1 AND card_type='connector-offer' AND card->>'offerId'=$2
          ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
        [offer.room_id, offer.id],
      )
    ).rows[0];
    if (card?.card.status === 'connecting') {
      await database.query(`UPDATE messages SET card=$2::jsonb WHERE id=$1`, [
        card.id,
        JSON.stringify({ ...card.card, status: 'accepted' }),
      ]);
    }

    const connectorName = connectorDisplayName(offer.connector_type);
    if (!offer.accepted_by) await ensureSystemIdentity(database);
    await systemLine(database, {
      roomId: offer.room_id,
      authorId: offer.accepted_by ?? SYSTEM_IDENTITY_ID,
      subject: offer.accepted_by ? identitySubject({
        id: offer.accepted_by,
        kind: offer.accepted_kind,
        name: offer.accepted_name,
      }) : { kind: 'system', name: connectorName },
      verb: offer.accepted_by ? (offer.intent === 'reconnect' ? 'reconnected' : 'added') : 'reconnected automatically',
      ...(offer.accepted_by ? { object: connectorName } : {}),
      kind: 'connector-offer-decided',
      ...(offer.command_id ? { commandId: offer.command_id } : {}),
      wakes: [offer.agent_id],
      cardType: 'connector-offer-decision',
      card: { offerId: offer.id, status: 'accepted', ...(connectorId ? { connectorId } : {}) },
    });
    completed.push({ offerId: offer.id, roomId: offer.room_id, agentId: offer.agent_id });
  }
  return completed;
}
