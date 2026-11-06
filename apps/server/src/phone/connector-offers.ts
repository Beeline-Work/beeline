import { queueSquireWork, squireMachineAddress, squireWorkStatus } from '../squire-machine.js';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import { isOfferableConnectorKind, type ConnectorOfferCardView, type ConnectorOfferStatus } from '@beeline/api-contract/connector-offers';
import { type SqlDatabase } from '../database.js';
import type { ConnectorKind } from '@beeline/api-contract/workbench';
import { createWallet, grantWalletDelegation } from '../wallet.js';
import { completeWalletConnectorOffer } from '../connector-offer-completion.js';
import type { PhoneContext } from './context.js';
import { Input, Output } from './types.js';
import { CONNECTOR_OFFER_AUTHORITY_MESSAGE, CONNECTOR_OFFER_WALLET_AUTHORITY_MESSAGE, unix } from './values.js';
import { phoneRequireWorkspaceMember, phoneRequireIdentity } from './access.js';
import { phoneArmConnectorPairing } from './connections.js';
import { phoneViewerWorkbenchWorkspace } from './workbench-catalog.js';


  /**
   * Start the connector offer's full sign-in ceremony. Authorization is
   * the captain's Q4 answer, decided here and never on the phone: the person
   * the agent ADDRESSED — whose keys the tool will hold — or a current
   * Workspace manager, who already owns Workspace configuration. Nobody else
   * can act on the card, whatever the phone shows.
   *
   * Google consent is owned by the agent's human owner and settles directly
   * from the OAuth callback. Other connectors still pair on the offering
   * agent's machine; their helper report settles the card and resumes the turn.
   * A `'switch'` offer re-arms the same row with `force_relogin_provider`, so
   * Squire's connect signs in again even while the bound session is valid.
   */
  export async function phoneAcceptConnectorOffer(ctx: PhoneContext, input: Input<'acceptConnectorOffer'>, viewerId: string): Promise<Output<'acceptConnectorOffer'>> {
    if (typeof input.offerId !== 'string' || !input.offerId) throw new Error('offerId is required');
    const offer = (
      await ctx.database.query<{
        id: string;
        agent_id: string;
        workspace_id: string;
        room_id: string;
        addressee_id: string;
        connector_type: string;
        machine_id: string;
        status: ConnectorOfferStatus;
        accepted_by: string | null;
        accepted_at: Date | null;
        intent: string;
        provider: string | null;
      }>(
        `SELECT id,agent_id,workspace_id,room_id,addressee_id,connector_type,machine_id,status,
                accepted_by,accepted_at,intent,provider
         FROM connector_offers WHERE id::text=$1`,
        [input.offerId],
      )
    ).rows[0];
    if (!offer) throw new Error('connector offer not found');
    if (offer.status === 'denied') throw new Error('connector offer conflict: already denied');
    if (offer.status === 'accepted') throw new Error('connector offer conflict: already accepted');
    if (!isOfferableConnectorKind(offer.connector_type))
      throw new Error(`connector offer is invalid: ${offer.connector_type} cannot be added`);
    const connectorType: ConnectorKind = offer.connector_type;
    if (connectorType === 'wallet') return ctx.acceptWalletOffer(offer, viewerId);
    if (offer.addressee_id !== viewerId) {
      const manager = await ctx.database.query(
        `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2
           AND role IN ('owner','admin') AND removed_at IS NULL`,
        [offer.workspace_id, viewerId],
      );
      if (!manager.rowCount) throw new Error(CONNECTOR_OFFER_AUTHORITY_MESSAGE);
    }
    // The addressee decides only while they are still in the Workspace.
    await ctx.requireWorkspaceMember(offer.workspace_id, viewerId);
    if (offer.status === 'connecting' && offer.accepted_by !== viewerId && offer.intent !== 'reconnect')
      throw new Error('connector offer conflict: sign-in is already in progress');
    // The helper is the offering agent's machine; it must still be here to install.
    const helper = await ctx.database.query<{ owner_id: string; machine_id: string }>(
      `SELECT a.owner_id,COALESCE(a.machine_id,a.agent_id) machine_id FROM agents a
       JOIN memberships m ON m.identity_id=a.agent_id AND m.workspace_id=$2
         AND m.room_id IS NULL AND m.removed_at IS NULL
       WHERE a.agent_id=$1`,
      [offer.agent_id, offer.workspace_id],
    );
    if (!helper.rowCount)
      throw new Error('connector offer conflict: the offering agent has left this Workspace');
    const acceptor = await ctx.requireIdentity(viewerId);
    if (offer.intent === 'reconnect' && offer.status === 'connecting' && connectorType === 'trusty-squire') {
      if (offer.addressee_id !== viewerId) throw new Error(CONNECTOR_OFFER_AUTHORITY_MESSAGE);
      await ctx.database.transaction(async database => {
        const work = await squireWorkStatus(database, offer.agent_id);
        if (work.status === 'error') await queueSquireWork(database, offer.agent_id,
          { install: true, forceReloginProvider: 'google' });
        const claimed = await database.query(`UPDATE connector_offers SET accepted_by=$2,accepted_at=COALESCE(accepted_at,now())
          WHERE id::text=$1 AND status='connecting' RETURNING id`, [input.offerId, viewerId]);
        if (!claimed.rowCount) throw new Error('connector offer conflict: already completed');
        await ctx.markConnectorOfferConnecting(database, { roomId: offer.room_id,
          offerId: input.offerId, acceptedBy: acceptor, acceptedAt: offer.accepted_at ?? new Date(),
          connectorId: squireMachineAddress(offer.machine_id) });
      });
      return { offerId: input.offerId, status: 'connecting', roomId: offer.room_id,
        connectorId: squireMachineAddress(offer.machine_id) };
    }
    const paired = await ctx.database.transaction(async (database) => {
      // Installation admission precedes offer/card effects; a lost offer CAS
      // rolls the installation back with this transaction.
      const squirePairing = connectorType === 'trusty-squire' ? await ctx.armConnectorPairing(database, {
        workspaceId: offer.workspace_id, ownerIdentityId: viewerId, connectorType,
        helperAgentId: offer.agent_id, machineId: offer.machine_id,
        ...(offer.intent === 'switch' && offer.provider ? { forceReloginProvider: offer.provider } : {}),
      }) : undefined;
      if (offer.status === 'failed' && (await database.query(`SELECT 1 FROM connector_offers
        WHERE room_id=$1 AND connector_type=$2 AND id::text<>$3 AND status IN ('pending','connecting')`,
        [offer.room_id, connectorType, input.offerId])).rowCount)
        throw new Error('connector offer conflict: use the newer connection card');
      const updated = await database.query<{ accepted_at: Date }>(
        `UPDATE connector_offers offer SET status='connecting',accepted_by=$2,
             accepted_at=CASE WHEN status='connecting' THEN accepted_at ELSE now() END
         WHERE offer.id::text=$1 AND (offer.status IN ('pending','failed')
           OR (offer.status='connecting' AND offer.accepted_by=$2))
           AND (offer.status<>'failed' OR NOT EXISTS(SELECT 1 FROM connector_offers current_offer
             WHERE current_offer.room_id=offer.room_id AND current_offer.connector_type=offer.connector_type
               AND current_offer.id<>offer.id AND current_offer.status IN ('pending','connecting')))
         RETURNING accepted_at`,
        [input.offerId, viewerId],
      );
      if (!updated.rowCount) throw new Error('connector offer conflict: already accepted');
      const acceptedAt = updated.rows[0]!.accepted_at;
      const pairing = squirePairing ?? await ctx.armConnectorPairing(database, {
        workspaceId: offer.workspace_id,
        ownerIdentityId: viewerId,
        connectorType,
        helperAgentId: offer.agent_id,
        machineId: offer.machine_id,
      });
      if (offer.intent === 'switch' && offer.provider && connectorType !== 'trusty-squire')
        await database.query(
          `UPDATE workspace_connectors SET force_relogin_provider=$2 WHERE id=$1::uuid`,
          [pairing.connectorId, offer.provider],
        );
      await database.query(`UPDATE connector_offers SET connector_id=$2::uuid WHERE id::text=$1`, [
        input.offerId,
        connectorType === 'trusty-squire' ? null : pairing.connectorId,
      ]);
      await ctx.markConnectorOfferConnecting(database, {
        roomId: offer.room_id,
        offerId: input.offerId,
        acceptedBy: acceptor,
        acceptedAt,
        connectorId: pairing.connectorId,
      });
      return pairing;
    }).catch(error=>{
      if (error?.code==='23505' && error.constraint==='connector_offers_open_idx')
        throw new Error('connector offer conflict: use the newer connection card');
      throw error;
    });
    return {
      offerId: input.offerId,
      status: 'connecting',
      roomId: offer.room_id,
      connectorId: paired.connectorId,
    };
  }

  /**
   * Accepting a wallet offer IS connecting the wallet: the addressee's own
   * grant to sign, the same step as Connect on the Workbench. A wallet binds a
   * signing key to one person, so a Workspace manager cannot accept it for
   * them. The card settles here and wakes the offering agent; there is no
   * helper ceremony to wait on.
   */
  export async function phoneAcceptWalletOffer(ctx: PhoneContext,
    offer: {
      id: string;
      workspace_id: string;
      room_id: string;
      addressee_id: string;
      status: ConnectorOfferStatus;
    },
    viewerId: string,
  ): Promise<Output<'acceptConnectorOffer'>> {
    if (offer.addressee_id !== viewerId) throw new Error(CONNECTOR_OFFER_WALLET_AUTHORITY_MESSAGE);
    await phoneRequireWorkspaceMember(ctx, offer.workspace_id, viewerId);
    if (offer.status !== 'pending') throw new Error('connector offer conflict: already accepted');
    await createWallet(ctx.database, viewerId, await phoneViewerWorkbenchWorkspace(ctx, viewerId));
    await grantWalletDelegation(ctx.database, viewerId, offer.workspace_id);
    const acceptor = await phoneRequireIdentity(ctx, viewerId);
    const completed = await ctx.database.transaction(async (database) => {
      const updated = await database.query<{ accepted_at: Date }>(
        `UPDATE connector_offers SET status='connecting',accepted_by=$2,
             accepted_at=COALESCE(accepted_at,now())
         WHERE id=$1::uuid AND status='pending' RETURNING accepted_at`,
        [offer.id, viewerId],
      );
      const acceptedAt = updated.rows[0]?.accepted_at;
      if (!acceptedAt) throw new Error('connector offer conflict: already accepted');
      await phoneMarkConnectorOfferConnecting(ctx, database, {
        roomId: offer.room_id,
        offerId: offer.id,
        acceptedBy: acceptor,
        acceptedAt,
      });
      return completeWalletConnectorOffer(database, offer.id);
    });
    for (const settled of completed) {
      ctx.live?.publish({
        type: 'invalidate',
        roomId: settled.roomId,
        reason: 'connector-offer',
        agentId: settled.agentId,
      });
    }
    return { offerId: offer.id, status: 'accepted', roomId: offer.room_id };
  }

  /**
   * Mark the card as an in-progress ceremony. It still names who acted and
   * carries the Workbench row id, but it cannot claim the tool was added until
   * the helper's connected report settles it.
   */
  export async function phoneMarkConnectorOfferConnecting(ctx: PhoneContext,
    database: SqlDatabase,
    input: {
      roomId: string;
      offerId: string;
      acceptedBy: RoomViewIdentity;
      acceptedAt: Date;
      connectorId?: string;
    },
  ) {
    const card = (
      await database.query<{ id: string; card: ConnectorOfferCardView }>(
        `SELECT id,card FROM messages
         WHERE room_id=$1 AND card_type='connector-offer' AND card->>'offerId'=$2
         ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
        [input.roomId, input.offerId],
      )
    ).rows[0];
    if (!card || !['pending', 'connecting', 'failed'].includes(card.card.status)) return;
    const connecting: ConnectorOfferCardView = {
      ...card.card,
      status: 'connecting',
      acceptedBy: input.acceptedBy,
      acceptedAt: unix(input.acceptedAt),
      ...(input.connectorId ? { connectorId: input.connectorId } : {}),
    };
    await database.query(`UPDATE messages SET card=$2::jsonb WHERE id=$1`, [
      card.id,
      JSON.stringify(connecting),
    ]);
  }
