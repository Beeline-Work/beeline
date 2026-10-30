import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { authorizeCommandOutput } from './agent-command.js';
import { ExpectedRefusalError } from './command-refusal.js';

type ReleaseDispatchInput = {
  roomId: string;
  requestId: string;
  generationId?: string;
  inputs?: Record<string, string>;
};

const RECOVERY_INPUTS = new Set([
  'release_sha', 'release_version', 'selection', 'store_track', 'run_release_proof', 'allow_pin_restore', 'publish_listing', 'mobile_store_minimum',
]);

/** Commit provenance before sending the request; never persist provider credentials. */
export async function productionReleaseDispatch(
  database: SqlDatabase,
  agentId: string,
  input: ReleaseDispatchInput,
  dispatch: (inputs: Record<string, string>) => Promise<void>,
): Promise<{ auditMessageId: string }> {
  const inputs = input.inputs ?? {};
  if (Object.entries(inputs).some(([key, value]) => !RECOVERY_INPUTS.has(key) || typeof value !== 'string' || value.length > 256))
    throw new Error('Invalid production release inputs');
  if (inputs.publish_listing !== undefined && !['true', 'false'].includes(inputs.publish_listing))
    throw new ExpectedRefusalError('publish_listing must be true or false');
  const auditMessageId = randomUUID();
  const dispatchedBy = await database.transaction(async db => {
    const agent = (await db.query<{ id: string; handle: string }>(
      `SELECT id,handle FROM identities WHERE id=$1 AND kind='agent' AND handle IS NOT NULL`, [agentId],
    )).rows[0];
    if (!agent?.handle) throw new Error('Production release requires an agent identity');
    const command = await authorizeCommandOutput(db, input.roomId, agentId, input.requestId, input.generationId);
    const human = (await db.query<{ id: string; text: string; role: string }>(
      `SELECT m.id,m.text,manager.role FROM messages m JOIN identities i ON i.id=m.author_id AND i.kind='human'
       JOIN rooms room ON room.id=$2
       JOIN memberships manager ON manager.workspace_id=room.workspace_id
         AND manager.room_id IS NULL AND manager.identity_id=m.author_id
         AND manager.removed_at IS NULL AND manager.role IN ('owner','admin')
       WHERE m.id=$1 AND m.deleted_at IS NULL`, [command.root_source_message_id, input.roomId],
    )).rows[0];
    if (!human) throw new ExpectedRefusalError('Production release requires a cited human command message from a workspace owner or admin');
    if (inputs.publish_listing === 'true') {
      // A dedicated imperative line makes listing consent unambiguous. Routine
      // release commands, questions, quoted text and negated requests do not count.
      const listingCommand = /^(?:@[a-z0-9_-]+\s+)?(?:please\s+)?(?:publish|update|upload|change|edit|replace|sync|submit)\s+(?:the\s+)?(?:(?:google\s+)?play\s+)?(?:store\s+)?(?:listing|store metadata|store)(?:\s+now)?[.!]?$/i;
      if (human.role !== 'owner' || !(human.text ?? '').split(/\r?\n/).some(line => listingCommand.test(line.trim())))
        throw new ExpectedRefusalError('Play listing is locked. publish_listing=true requires a workspace owner command with an explicit line such as: Publish the Play listing');
    }
    const provenance = JSON.stringify({
      agentId: agent.id, handle: agent.handle, place: input.roomId,
      humanCommandMessageId: human.id, auditMessageId,
    });
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,durable_fact)
       VALUES($1,$2,$3,$4,'action')`,
      [auditMessageId, input.roomId, agent.id, `Production release dispatch requested: ${provenance}`],
    );
    return provenance;
  });
  await dispatch({ ...inputs, dispatched_by: dispatchedBy });
  return { auditMessageId };
}
