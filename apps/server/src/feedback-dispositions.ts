import type { SqlDatabase } from './database.js';
import type { CommandRow } from './agent-command.js';
import { containsSecret, feedbackConfigFromEnv } from './feedback.js';

/** Persist the triager's assessment in the same transaction as its handoff. */
export async function applyFeedbackDispositions(db: SqlDatabase, command: CommandRow, value: unknown): Promise<void> {
  if (!Array.isArray(value)) throw new Error('dispositions must be an array');
  const seen = new Set<string>();
  const owner = (await db.query<{ owner_id: string }>('SELECT owner_id FROM agents WHERE agent_id=$1', [command.agent_id])).rows[0]?.owner_id;
  const global = Boolean(owner && feedbackConfigFromEnv().systemSenders.includes(owner));
  const workspace = (await db.query<{ workspace_id: string }>('SELECT workspace_id FROM rooms WHERE id=$1', [command.room_id])).rows[0]?.workspace_id;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') throw new Error('each disposition must be an object');
    const { itemId, disposition, reference, reason } = raw as Record<string, unknown>;
    if (typeof itemId !== 'string' || seen.has(itemId)) throw new Error('each feedback item needs exactly one disposition');
    seen.add(itemId);
    if (!['fixed', 'duplicate', 'linked', 'dismissed'].includes(String(disposition))) throw new Error('unknown feedback disposition');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('a disposition needs its reason');
    if (containsSecret(reason + String(reference ?? ''))) throw new Error('feedback disposition contains a secret-shaped value');
    const item = (await db.query<{ status: string; workspace_id: string }>(
      'SELECT status,workspace_id FROM feedback_items WHERE id=$1 FOR UPDATE', [itemId])).rows[0];
    if (!item || (!global && item.workspace_id !== workspace)) throw new Error('feedback item is unavailable in this workspace');
    // Fixed is certified by notify_feedback_fixed, which verifies the merged PR.
    if (disposition === 'fixed' && item.status !== 'resolved') throw new Error('verify the merged fix with notify_feedback_fixed before marking fixed');
    if (disposition === 'linked' && (typeof reference !== 'string' || !reference.trim())) throw new Error('linked needs a corner or pull request reference');
    if (disposition === 'duplicate') {
      if (typeof reference !== 'string' || reference === itemId) throw new Error('duplicate needs a different canonical item');
      const canonical = (await db.query<{ workspace_id: string; status: string }>(
        'SELECT workspace_id,status FROM feedback_items WHERE id=$1 FOR UPDATE', [reference])).rows[0];
      if (!canonical || (!global && canonical.workspace_id !== workspace) || ['closed', 'dismissed'].includes(canonical.status)) throw new Error('canonical feedback item is unavailable');
      if (item.status !== 'closed') await db.query(`UPDATE feedback_items target SET
        occurrence_count=target.occurrence_count+source.occurrence_count,
        last_occurrence_at=GREATEST(target.last_occurrence_at,target.created_at,source.last_occurrence_at,source.created_at),
        occurrences=target.occurrences || jsonb_build_array(jsonb_build_object('itemId',source.id,'agentId',source.reporter_identity_id,'createdAt',source.created_at)) || source.occurrences
        FROM feedback_items source WHERE target.id=$1 AND source.id=$2`, [reference, itemId]);
    }
    const status = disposition === 'fixed' ? 'resolved' : disposition === 'duplicate' ? 'closed' : disposition === 'linked' ? 'attached' : 'dismissed';
    await db.query('UPDATE feedback_items SET status=$2,triage_reason=$3,triaged_at=now() WHERE id=$1',
      [itemId, status, JSON.stringify({ disposition, reference, reason })]);
  }
}
