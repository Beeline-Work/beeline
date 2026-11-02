import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  readVaultSaveCard,
  vaultSaveRequest,
  vaultSaveValues,
  type VaultSaveCard,
} from '@beeline/api-contract/daemon';
import type { TokenAuth } from './auth.js';
import { bearer } from './auth.js';
import type { SqlDatabase } from './database.js';
import type { PhoneService } from './phone-service.js';
import type { LiveHub } from './live.js';
import type { VaultSaveRelay } from './vault-save-relay.js';
import { systemLine } from './system-line.js';
import { createAgentCommand, type CommandRow } from './agent-command.js';

/** Dedicated boundary: all exceptions and provider failures become fixed, secret-free replies. */
export async function vaultSaveHttp(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: { auth: TokenAuth; database: SqlDatabase; phone: PhoneService; live: LiveHub },
  relay: VaultSaveRelay,
): Promise<void> {
  const reply = (status: number, result: object) => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    });
    response.end(JSON.stringify(result));
  };
  let input: Record<string, unknown> | undefined;
  let values: Record<string, string> | undefined;
  let claimed: { cardId: string; attemptId: string } | undefined;
  try {
    if (request.method !== 'POST') {
      reply(405, { error: 'invalid_request' });
      return;
    }
    const token = bearer(request.headers.authorization);
    const answer = request.url === '/v1/vault-save/answer';
    const actor = token
      ? await (answer
          ? dependencies.auth.authenticateDaemon(token)
          : dependencies.auth.authenticatePhone(token))
      : null;
    if (!actor) {
      reply(401, { error: 'unauthorized' });
      return;
    }
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 200_000) {
        reply(413, { error: 'invalid_request' });
        return;
      }
    }
    input = JSON.parse(raw) as Record<string, unknown>;
    raw = '';
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid');
    if (answer) {
      const target =
        typeof input.attemptId === 'string' ? input.attemptId.split(':')[0] : undefined;
      if (
        target &&
        /^[0-9a-f]{14,16}$/.test(target) &&
        target !== relay.instanceId &&
        process.env.FLY_MACHINE_ID
      ) {
        response.writeHead(307, {
          'fly-replay': `instance=${target};timeout=5s`,
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }
      relay.answer(actor, input.attemptId, input.answer);
      reply(200, { ok: true });
      return;
    }
    if (
      request.url !== '/v1/vault-save/submit' ||
      typeof input.cardId !== 'string' ||
      typeof input.roomId !== 'string'
    )
      throw new Error('invalid');
    const { cardId, roomId } = input;
    if (!(await dependencies.phone.canReadRoom(roomId, actor))) {
      reply(403, { error: 'access_denied' });
      return;
    }
    const row = (
      await dependencies.database.query<{ card: VaultSaveCard & { originCommandId: string } }>(
        `SELECT m.card FROM messages m JOIN agents a ON a.agent_id=m.card->>'agentId'
       JOIN room_access agent_member ON agent_member.identity_id=a.agent_id AND agent_member.room_id=m.room_id AND agent_member.removed_at IS NULL
       JOIN memberships owner ON owner.identity_id=a.owner_id AND owner.room_id IS NULL
         AND owner.workspace_id=(SELECT workspace_id FROM rooms WHERE id=m.room_id) AND owner.removed_at IS NULL
       WHERE m.id=$1 AND m.room_id=$2 AND m.card_type='vault-save' AND m.card->>'ownerId'=$3 AND a.owner_id=$3`,
        [cardId, roomId, actor],
      )
    ).rows[0];
    if (!row) {
      reply(403, { error: 'access_denied' });
      return;
    }
    if (row.card.status === 'saved') {
      reply(200, { status: 'saved', card: readVaultSaveCard(row.card) });
      return;
    }
    if (
      !relay.hasHelper(row.card.agentId) &&
      process.env.FLY_MACHINE_ID &&
      !request.headers['fly-replay-src']
    ) {
      const connection = (
        await dependencies.database.query<{ instance_id: string }>(
          `SELECT instance_id FROM agent_connections WHERE agent_id=$1 AND released_at IS NULL`,
          [row.card.agentId],
        )
      ).rows[0];
      const target = connection?.instance_id.split(':')[0];
      if (target && /^[0-9a-f]{14,16}$/.test(target) && target !== relay.instanceId) {
        // Route to the socket's server without a PostgreSQL payload or a durable queue.
        response.writeHead(307, {
          'fly-replay': `instance=${target};timeout=5s`,
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }
    }
    values = vaultSaveValues(row.card, input.values);
    delete input.values;
    const attemptId = randomUUID();
    const lock = await dependencies.database.query(
      `UPDATE messages SET card=card||jsonb_build_object('status','saving','savingAt',extract(epoch from now()),'savingAttempt',$2::text)
       WHERE id=$1 AND card_type='vault-save' AND (card->>'status'='pending' OR
         (card->>'status'='saving' AND (card->>'savingAt')::numeric < extract(epoch from now())-120)) RETURNING id`,
      [cardId, attemptId],
    );
    if (!lock.rows.length) {
      reply(409, { status: 'retry' });
      return;
    }
    claimed = { cardId, attemptId };
    const { service, label, purpose, fields, allowedHosts, authStrategy } = row.card;
    const metadata = vaultSaveRequest({
      service,
      label,
      purpose,
      fields,
      allowedHosts,
      authStrategy,
    });
    const result = await relay.submit(row.card.agentId, cardId, roomId, metadata, values);
    if (result.status === 'saved') {
      await dependencies.database.transaction(async (database) => {
        const updated = await database.query(
          `UPDATE messages SET card=(card-'savingAt'-'savingAttempt')||jsonb_build_object('status','saved','reference',$2::text,'savedAt',extract(epoch from now()),'allowedHosts',$3::jsonb)
         WHERE id=$1 AND card_type='vault-save' AND card->>'status'='saving' AND card->>'savingAttempt'=$4 RETURNING id`,
          [
            cardId,
            result.reference,
            JSON.stringify(result.allowedHosts ?? metadata.allowedHosts),
            attemptId,
          ],
        );
        if (!updated.rows.length) return;
        const line = await systemLine(database, {
          roomId,
          subject: { kind: 'person', id: actor, name: row.card.ownerName },
          verb: 'saved a vault entry',
          object: `${metadata.service} / ${metadata.label}`,
          consequence: `${result.reference} · fields: ${metadata.fields.map((field) => field.name).join(', ')} · hosts: ${(result.allowedHosts ?? metadata.allowedHosts).join(', ')}`,
        });
        const parent = (
          await database.query<CommandRow>(
            `SELECT * FROM agent_commands WHERE id=$1 AND agent_id=$2 AND room_id=$3`,
            [row.card.originCommandId, row.card.agentId, roomId],
          )
        ).rows[0];
        if (parent)
          await createAgentCommand(database, {
            roomId,
            agentId: row.card.agentId,
            sourceMessageId: line.id,
            reason: 'vault_saved',
            action: 'resume',
            parent,
            retainDepth: true,
          });
      });
    } else {
      await dependencies.database.query(
        `UPDATE messages SET card=(card-'savingAt'-'savingAttempt')||'{"status":"pending"}'::jsonb
        WHERE id=$1 AND card_type='vault-save' AND card->>'status'='saving' AND card->>'savingAttempt'=$2`,
        [cardId, attemptId],
      );
    }
    claimed = undefined;
    dependencies.live.publish({
      type: 'invalidate',
      roomId,
      reason: 'vault-save',
      messageId: cardId,
    });
    const card =
      result.status === 'saved'
        ? (
            await dependencies.database.query<{ card: unknown }>(
              `SELECT card FROM messages WHERE id=$1`,
              [cardId],
            )
          ).rows[0]?.card
        : undefined;
    reply(200, { status: result.status, ...(card ? { card: readVaultSaveCard(card) } : {}) });
  } catch {
    if (claimed) {
      await dependencies.database
        .query(
          `UPDATE messages SET card=(card-'savingAt'-'savingAttempt')||'{"status":"pending"}'::jsonb
        WHERE id=$1 AND card_type='vault-save' AND card->>'status'='saving' AND card->>'savingAttempt'=$2`,
          [claimed.cardId, claimed.attemptId],
        )
        .catch(() => {});
    }
    reply(200, { status: 'retry' });
  } finally {
    if (values) for (const name of Object.keys(values)) delete values[name];
    if (input) delete input.values;
  }
}
