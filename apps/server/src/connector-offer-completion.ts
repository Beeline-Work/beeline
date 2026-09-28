import type { ConnectorOfferCardView } from '@beeline/api-contract/connector-offers';
import type { SqlDatabase } from './database.js';
import { connectorDisplayName } from './workbench.js';
import { identitySubject, systemLine } from './system-line.js';

type ConnectingOffer = {
  id: string;
  room_id: string;
  agent_id: string;
  command_id: string | null;
  connector_type: ConnectorOfferCardView['connectorType'];
  accepted_by: string;
  accepted_at: Date;
  accepted_name: string;
  accepted_kind: 'human' | 'agent';
};

export type CompletedConnectorOffer = {
  readonly offerId: string;
  readonly roomId: string;
  readonly agentId: string;
};

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
  const offers = (
    await database.query<ConnectingOffer>(
      `SELECT offer.id,offer.room_id,offer.agent_id,offer.command_id,offer.connector_type,
              offer.accepted_by,offer.accepted_at,
              acceptor.name accepted_name,acceptor.kind accepted_kind
         FROM connector_offers offer
         JOIN identities acceptor ON acceptor.id=offer.accepted_by
        WHERE offer.connector_id=$1::uuid AND offer.status='connecting'
        ORDER BY offer.created_at,offer.id
        FOR UPDATE OF offer`,
      [connectorId],
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
    await systemLine(database, {
      roomId: offer.room_id,
      authorId: offer.accepted_by,
      subject: identitySubject({
        id: offer.accepted_by,
        kind: offer.accepted_kind,
        name: offer.accepted_name,
      }),
      verb: 'added',
      object: connectorName,
      kind: 'connector-offer-decided',
      ...(offer.command_id ? { commandId: offer.command_id } : {}),
      wakes: [offer.agent_id],
      cardType: 'connector-offer-decision',
      card: { offerId: offer.id, status: 'accepted', connectorId },
    });
    completed.push({ offerId: offer.id, roomId: offer.room_id, agentId: offer.agent_id });
  }
  return completed;
}
