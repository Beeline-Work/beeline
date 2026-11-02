import { committedCommandNotificationSchema } from './postgres-live-notifications.js';
/** A notification is only a wake hint. Every wake checks the durable row again.
 * The process's existing PostgreSQL listener calls notifyCommandCompletion;
 * reconnect calls recoverCommandCompletions after LISTEN has committed. */
export { COMMAND_COMPLETION_CHANNEL } from './postgres-live-notifications.js';
export interface CommandCompletionKey { principal: string; operation: string; commandId: string }
const listeners = new Map<string, Set<() => void>>();
const keyOf = (key: CommandCompletionKey) => JSON.stringify([key.principal, key.operation, key.commandId]);
export function notifyCommandCompletion(payload: string | CommandCompletionKey): void {
  let key: CommandCompletionKey;
  try {
    const value: unknown = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!value || typeof value !== 'object') return;
    key = value as CommandCompletionKey;
    if (![key.principal, key.operation, key.commandId].every(value => typeof value === 'string')) return;
  } catch { return; }
  for (const listener of listeners.get(keyOf(key)) ?? []) listener();
}
export function recoverCommandCompletions(): void {
  for (const group of listeners.values()) for (const listener of group) listener();
}
export function subscribeCommandCompletion(key: CommandCompletionKey, listener: () => void): () => void {
  const id = keyOf(key);
  let group = listeners.get(id);
  if (!group) listeners.set(id, group = new Set());
  group.add(listener);
  return () => { group.delete(listener); if (!group.size) listeners.delete(id); };
}

/** Subscribe before the initial inspection. One terminal deadline ends this
 * wait; it never schedules another observation. Dirty coalescing preserves an
 * event received while the initial inspection is in flight. */
export async function waitForCommittedChange<T>(
  subscribe: (listener: () => void) => (() => void) | Promise<() => void>,
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  signal?.throwIfAborted();
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false, reading = false, dirty = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (error?: unknown, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      unsubscribe?.();
      if (error !== undefined) reject(error); else resolve(result);
    };
    const abort = () => finish(signal?.reason ?? new Error('aborted'));
    const timer = setTimeout(() => finish(), Math.max(0, timeoutMs));
    timer.unref?.();
    const inspect = async () => {
      dirty = true;
      if (reading || settled) return;
      reading = true;
      try {
        do {
          dirty = false;
          const value = await read();
          if (settled) return;
          if (value !== undefined) { finish(undefined, value); return; }
        } while (dirty && !settled);
      } catch (error) { finish(error); }
      finally { reading = false; }
    };
    signal?.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(() => subscribe(() => { void inspect(); })).then(release => {
      unsubscribe = release;
      if (settled) release(); else void inspect();
    }, error => finish(error));
  });
}

/** ID-only committed notifications reuse the existing server listener. These
 * contain no provider tokens, ceremony URL or personalized read payload. */
export const COMMAND_COMPLETION_SCHEMA = `
${committedCommandNotificationSchema()}
CREATE OR REPLACE FUNCTION beeline_completion_changed() RETURNS trigger AS $$
DECLARE item jsonb; previous jsonb; command_key jsonb;
BEGIN
 item := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 previous := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 IF TG_TABLE_NAME='workspace_connectors' THEN
   IF TG_OP='UPDATE' AND (item->'status',item->'sign_in',item->'status_error')
       IS NOT DISTINCT FROM (previous->'status',previous->'sign_in',previous->'status_error') THEN RETURN NULL; END IF;
   command_key := jsonb_build_object('principal','connector','operation','status','commandId',item->>'id');
 ELSIF TG_TABLE_NAME='agents' THEN
   IF TG_OP='UPDATE' AND (item->'squire_work',item->'squire_report')
       IS NOT DISTINCT FROM (previous->'squire_work',previous->'squire_report') THEN RETURN NULL; END IF;
   command_key := jsonb_build_object('principal','connector','operation','machine',
     'commandId',(item->>'owner_id') || ':' || COALESCE(item->>'machine_id',item->>'agent_id'));
 ELSIF TG_TABLE_NAME='rooms_mcp_idempotency' THEN
   IF TG_OP='UPDATE' AND (item->'message_id',item->'result')
       IS NOT DISTINCT FROM (previous->'message_id',previous->'result') THEN RETURN NULL; END IF;
   command_key := jsonb_build_object('principal',item->>'member_id','operation','rooms-mcp-send','commandId',item->>'idempotency_key');
 END IF;
 IF command_key IS NOT NULL THEN PERFORM beeline_notify_committed_command(command_key::text); END IF;
 RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_connector_completion ON workspace_connectors;
CREATE TRIGGER beeline_connector_completion AFTER INSERT OR UPDATE OR DELETE ON workspace_connectors
 FOR EACH ROW EXECUTE FUNCTION beeline_completion_changed();
DROP TRIGGER IF EXISTS beeline_squire_completion ON agents;
CREATE TRIGGER beeline_squire_completion AFTER INSERT OR UPDATE OR DELETE ON agents
 FOR EACH ROW EXECUTE FUNCTION beeline_completion_changed();
DROP TRIGGER IF EXISTS beeline_mcp_send_completion ON rooms_mcp_idempotency;
CREATE TRIGGER beeline_mcp_send_completion AFTER INSERT OR UPDATE OR DELETE ON rooms_mcp_idempotency
 FOR EACH ROW EXECUTE FUNCTION beeline_completion_changed();
`;
