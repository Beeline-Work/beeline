import { committedCommandNotificationSchema } from './postgres-live.js';
import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import type { McpPrincipal } from './rooms-mcp-oauth.js';
import { subscribeCommandCompletion } from './command-completion.js';
import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';
import type { WorkTimers } from './background-work.js';

/** Separate rollout floor; enable only after real-PG source/authority proofs. */
export { networkRouterEnabled as memberStreamEnabled } from './network-router-rollout.js';

/** Compact causes share the existing commit-ordered journal and listener. No
 * personalized DTO or client cache inventory is recorded in the journal. */
export const MCP_MEMBER_STREAM_SCHEMA = `
${committedCommandNotificationSchema()}
CREATE INDEX IF NOT EXISTS rooms_mcp_members_stream_member_idx ON rooms_mcp_members(member_id);
CREATE OR REPLACE FUNCTION beeline_mcp_stream(member text, cause jsonb) RETURNS void AS $$
BEGIN
 PERFORM beeline_journal('mcp:'||member,cause);
 PERFORM beeline_notify_committed_command(json_build_object('principal','mcp','operation','stream','commandId',member)::text);
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION beeline_mcp_stream_source() RETURNS trigger AS $$
DECLARE item jsonb; member text;
BEGIN
 item:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='rooms_mcp_mentions' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.cleared_at,NEW.rewakes) IS NOT DISTINCT FROM ROW(OLD.cleared_at,OLD.rewakes) THEN RETURN NULL; END IF;
   PERFORM beeline_mcp_stream(item->>'member_id',jsonb_build_object('kind','mention','id',item->>'message_id'));
 ELSIF TG_TABLE_NAME='agent_commands' THEN
   IF item->>'reason'='mcp_call' THEN RETURN NULL; END IF;
   IF TG_OP='UPDATE' AND ROW(NEW.state,NEW.hiccup_attempts,NEW.private_payload,NEW.source_message_id)
     IS NOT DISTINCT FROM ROW(OLD.state,OLD.hiccup_attempts,OLD.private_payload,OLD.source_message_id) THEN RETURN NULL; END IF;
   IF EXISTS(SELECT 1 FROM rooms_mcp_members WHERE member_id=item->>'agent_id') THEN
     PERFORM beeline_mcp_stream(item->>'agent_id',jsonb_build_object('kind','wake','id',item->>'id'));
   END IF;
 ELSIF TG_TABLE_NAME='rooms_mcp_members' THEN
   PERFORM beeline_mcp_stream(item->>'member_id',jsonb_build_object('kind','authority'));
 ELSIF TG_TABLE_NAME='memberships' THEN
   IF TG_OP='UPDATE' AND ROW(NEW.removed_at,NEW.role) IS NOT DISTINCT FROM ROW(OLD.removed_at,OLD.role) THEN RETURN NULL; END IF;
   IF EXISTS(SELECT 1 FROM rooms_mcp_members WHERE member_id=item->>'identity_id') THEN
     PERFORM beeline_mcp_stream(item->>'identity_id',jsonb_build_object('kind','authority'));
   END IF;
 ELSE
   FOR member IN SELECT m.member_id FROM rooms_mcp_members m
     WHERE m.client_id=item->>'client_id' AND m.owner_id=item->>'identity_id'
   LOOP PERFORM beeline_mcp_stream(member,jsonb_build_object('kind','authority')); END LOOP;
 END IF;
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION beeline_mcp_authority_lock() RETURNS trigger AS $$
DECLARE item jsonb; member text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('${ROUTER_AUTHORITY_LOCK}',0));
 item:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 FOR member IN SELECT m.member_id FROM rooms_mcp_members m WHERE
   (TG_TABLE_NAME='rooms_mcp_members' AND m.member_id=item->>'member_id') OR
   (m.client_id=item->>'client_id' AND m.owner_id=item->>'identity_id')
 LOOP
   INSERT INTO router_authority(scope) VALUES('mcp:'||member)
     ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_mcp_stream_source ON rooms_mcp_mentions;
CREATE TRIGGER beeline_mcp_stream_source AFTER INSERT OR UPDATE OR DELETE ON rooms_mcp_mentions FOR EACH ROW EXECUTE FUNCTION beeline_mcp_stream_source();
DROP TRIGGER IF EXISTS beeline_mcp_stream_source ON agent_commands;
CREATE TRIGGER beeline_mcp_stream_source AFTER INSERT OR UPDATE OR DELETE ON agent_commands FOR EACH ROW EXECUTE FUNCTION beeline_mcp_stream_source();
DROP TRIGGER IF EXISTS beeline_mcp_stream_source ON memberships;
CREATE TRIGGER beeline_mcp_stream_source AFTER INSERT OR UPDATE OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION beeline_mcp_stream_source();
DROP TRIGGER IF EXISTS beeline_mcp_authority_lock ON rooms_mcp_tokens;
CREATE TRIGGER beeline_mcp_authority_lock BEFORE UPDATE OF revoked_at,expires_at,scope OR DELETE ON rooms_mcp_tokens FOR EACH ROW EXECUTE FUNCTION beeline_mcp_authority_lock();
DROP TRIGGER IF EXISTS beeline_mcp_stream_source ON rooms_mcp_tokens;
CREATE TRIGGER beeline_mcp_stream_source AFTER UPDATE OF revoked_at,expires_at,scope OR DELETE ON rooms_mcp_tokens FOR EACH ROW EXECUTE FUNCTION beeline_mcp_stream_source();
DROP TRIGGER IF EXISTS beeline_mcp_authority_lock ON rooms_mcp_connections;
CREATE TRIGGER beeline_mcp_authority_lock BEFORE UPDATE OF revoked_at,scope OR DELETE ON rooms_mcp_connections FOR EACH ROW EXECUTE FUNCTION beeline_mcp_authority_lock();
DROP TRIGGER IF EXISTS beeline_mcp_stream_source ON rooms_mcp_connections;
CREATE TRIGGER beeline_mcp_stream_source AFTER UPDATE OF revoked_at,scope OR DELETE ON rooms_mcp_connections FOR EACH ROW EXECUTE FUNCTION beeline_mcp_stream_source();
DROP TRIGGER IF EXISTS beeline_mcp_authority_lock ON rooms_mcp_families;
CREATE TRIGGER beeline_mcp_authority_lock BEFORE UPDATE OF revoked_at OR DELETE ON rooms_mcp_families FOR EACH ROW EXECUTE FUNCTION beeline_mcp_authority_lock();
DROP TRIGGER IF EXISTS beeline_mcp_stream_source ON rooms_mcp_families;
CREATE TRIGGER beeline_mcp_stream_source AFTER UPDATE OF revoked_at OR DELETE ON rooms_mcp_families FOR EACH ROW EXECUTE FUNCTION beeline_mcp_stream_source();
DROP TRIGGER IF EXISTS beeline_mcp_authority_lock ON rooms_mcp_members;
CREATE TRIGGER beeline_mcp_authority_lock BEFORE DELETE ON rooms_mcp_members FOR EACH ROW EXECUTE FUNCTION beeline_mcp_authority_lock();
DROP TRIGGER IF EXISTS beeline_mcp_stream_source ON rooms_mcp_members;
CREATE TRIGGER beeline_mcp_stream_source AFTER DELETE ON rooms_mcp_members FOR EACH ROW EXECUTE FUNCTION beeline_mcp_stream_source();
INSERT INTO live_streams(id) SELECT 'mcp:'||member_id FROM rooms_mcp_members ON CONFLICT DO NOTHING;
INSERT INTO router_authority(scope) SELECT 'mcp:'||member_id FROM rooms_mcp_members ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION beeline_mcp_stream_member() RETURNS trigger AS $$
BEGIN
 INSERT INTO live_streams(id) VALUES('mcp:'||NEW.member_id) ON CONFLICT DO NOTHING;
 INSERT INTO router_authority(scope) VALUES('mcp:'||NEW.member_id) ON CONFLICT(scope) DO UPDATE SET epoch=router_authority.epoch+1;
 RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_mcp_stream_member ON rooms_mcp_members;
CREATE TRIGGER beeline_mcp_stream_member AFTER INSERT ON rooms_mcp_members FOR EACH ROW EXECUTE FUNCTION beeline_mcp_stream_member();
`;
export interface McpStreamCursor {
  epoch: string; through: number;
  /** The stored cut is unchanged, but its owed backlog still has more pages. */
  pending?:true;
}
interface McpWakeCursor {createdAt:string;id:string}
interface McpStreamPage {
  nextWakeCursor?:McpWakeCursor; moreWakes?:boolean;
  mentions: readonly { id: string; room_id: string; [key: string]: unknown }[];
  wakes: readonly { id: string; address: string; [key: string]: unknown }[];
  nextCursor: string; more: boolean;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function currentCredential(db: SqlDatabase, principal: McpPrincipal): Promise<Date | undefined> {
  return (await db.query<{expires_at: Date}>(`SELECT t.expires_at FROM rooms_mcp_tokens t
    LEFT JOIN rooms_mcp_families f ON f.id=t.family_id
    JOIN rooms_mcp_connections c ON c.client_id=t.client_id AND c.identity_id=t.identity_id AND c.revoked_at IS NULL
    JOIN rooms_mcp_members m ON m.client_id=c.client_id AND m.owner_id=c.identity_id AND m.member_id=$4
    WHERE t.hash=$1 AND t.client_id=$2 AND t.identity_id=$3 AND t.revoked_at IS NULL AND t.expires_at>now()
      AND t.scope ~ '(^| )rooms:read( |$)' AND c.scope ~ '(^| )rooms:read( |$)'
      AND (t.family_id IS NULL OR (f.id IS NOT NULL AND f.revoked_at IS NULL AND f.client_id=t.client_id AND f.identity_id=t.identity_id))`,
    [principal.hash,principal.client_id,principal.identity_id,principal.member_id])).rows[0]?.expires_at;
}
async function scopes(db: SqlDatabase, member: string, rooms: readonly string[]) {
  const expected = await db.query<{scope: string; epoch: string}>(`SELECT scope,epoch::text FROM router_authority WHERE scope='mcp:'||$1 OR scope IN (
    SELECT 'room:'||id FROM rooms WHERE id=ANY($2::uuid[])
    UNION SELECT 'reader:'||$1||':workspace:'||workspace_id FROM rooms WHERE id=ANY($2::uuid[])) ORDER BY scope`, [member,rooms]);
  if (!expected.rows.some(row=>row.scope===`mcp:${member}`)) throw new Error('member stream authority missing');
  const allowed = await db.query(`SELECT r.id FROM rooms r JOIN room_access access ON access.room_id=r.id
    AND access.identity_id=$1 AND access.removed_at IS NULL
    JOIN memberships workspace ON workspace.workspace_id=r.workspace_id AND workspace.identity_id=$1
    AND workspace.room_id IS NULL AND workspace.removed_at IS NULL WHERE r.id=ANY($2::uuid[]) AND r.archived_at IS NULL`, [member,rooms]);
  if (allowed.rowCount !== new Set(rooms).size) throw new Error('member stream authority changed');
  return expected.rows;
}
/** A per-connection drain stores transport cursor only. Subscribe precedes the
 * initial repeatable-read cut. Each real committed hint coalesces one drain;
 * an idle stream makes no reads, writes, empty responses or heartbeat frames. */
export async function serveMcpMemberStream(database: SqlDatabase, principal: McpPrincipal, response: ServerResponse,
  input: { cursor?: McpStreamCursor; mentionCursor: string },
  page: (db: SqlDatabase, after: string, wakeAfter?:McpWakeCursor) => Promise<McpStreamPage>, timers: WorkTimers = { setTimeout, clearTimeout }): Promise<void> {
  if (!principal.member_id || !principal.scope.split(' ').includes('rooms:read')) throw new Error('member stream unavailable');
  const member = principal.member_id, stream = `mcp:${member}`;
  let stopped = false, running = false, dirty = true, initial = true, continuing = false, position = input.cursor, mentionCursor = input.mentionCursor;
  let wakeAfter:McpWakeCursor|undefined, catchupCut:McpStreamCursor|undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const close = (reason?: 'expired' | 'unavailable') => {
    if (stopped) return; stopped=true; release(); if (expiry) timers.clearTimeout(expiry);
    if (reason && !response.destroyed && !response.writableEnded) response.write(JSON.stringify({v:1,type:'ended',reason})+'\n');
    if (!response.writableEnded) response.end();
  };
  const release = subscribeCommandCompletion({principal:'mcp',operation:'stream',commandId:member}, () => { dirty=true; void drain(); });
  response.once('close',()=>close());
  response.writeHead(200, {'content-type':'application/x-ndjson','cache-control':'no-store','x-content-type-options':'nosniff'});
  response.flushHeaders();
  const drain = async () => {
    if (running || stopped) return; running=true;
    try {
      while (dirty && !stopped) {
        dirty=false;
        const prepared = await database.transaction(async db => {
          await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const expiresAt = await currentCredential(db,principal);
          if (!expiresAt) throw new Error('member stream credential ended');
          const head = (await db.query<{epoch:string; sequence:string}>('SELECT epoch,sequence::text FROM live_streams WHERE id=$1',[stream])).rows[0];
          if (!head) throw new Error('member stream source missing');
          const observed = {epoch:head.epoch,through:Number(head.sequence)}, to=catchupCut??observed;
          if (!Number.isSafeInteger(to.through)) throw new Error('member stream cursor overflow');
          if (!continuing && !position?.pending && position?.epoch === to.epoch && position.through === to.through) {
            if (!initial) return undefined;
            // Credential renewal resumes the existing delivery cursor; it does
            // not reread an unchanged application inbox.
            return {to,after:mentionCursor,encoded:[JSON.stringify({v:1,type:'checkpoint',cursor:to,mentionCursor})+'\n'],
              rooms:[],authority:digest(await scopes(db,member,[])),expiresAt};
          }
          // The durable owed ledger is the recovery source even after journal
          // retention/epoch changes; delivered IDs keep catch-up replay-safe.
          const frames: object[] = []; const roomIds = new Set<string>(); const wakeIds=new Set<string>(); let after=mentionCursor;
          {
            const current = await page(db,after,wakeAfter);
            for (const mention of current.mentions) {
              roomIds.add(mention.room_id);
              frames.push({v:1,type:'delivery',deliveryId:`mention:${mention.id}:${mention.rewakes ?? 0}`,mentions:[mention],wakes:[],mentionCursor:String(mention.deliveryCursor ?? after)});
            }
            for (const wake of current.wakes) {
              if (wakeIds.has(wake.id)) continue;
              wakeIds.add(wake.id); roomIds.add(wake.address);
              frames.push({v:1,type:'delivery',deliveryId:`wake:${wake.id}:${wake.deliveryVersion ?? 0}`,mentions:[],wakes:[wake],mentionCursor:current.nextCursor});
            }
            after=current.nextCursor;
            continuing = current.more || current.moreWakes === true;
            if(continuing)catchupCut??=to;
            if(current.nextWakeCursor)wakeAfter=current.nextWakeCursor;
          }
          // Only the final page claims the captured stream head. Intermediate
          // checkpoints keep the old cut; delivered mention IDs are durable.
          frames.push({v:1,type:'checkpoint',cursor:continuing ? {...(position ?? {epoch:to.epoch,through:0}),pending:true} : to,mentionCursor:after});
          const encoded = frames.map(frame=>JSON.stringify(frame)+'\n');
          const rooms=[...roomIds];
          return {to,after,encoded,rooms,authority:digest(await scopes(db,member,rooms)),expiresAt,newer:observed.epoch!==to.epoch||observed.through!==to.through};
        });
        if (!prepared || stopped) continue;
        if (expiry) timers.clearTimeout(expiry);
        expiry=timers.setTimeout(()=>close('expired'),Math.max(0,prepared.expiresAt.getTime()-Date.now())); expiry.unref?.();
        // Bound the transport queue, then reacquire the current-authority
        // fence for each enqueue. Never hold revocation locks while awaiting I/O.
        let frameIndex=0, offset=0;
        while (frameIndex < prepared.encoded.length && !stopped) {
          let writable=true;
          await database.transaction(async db => {
            await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
            if (!await currentCredential(db,principal) || digest(await scopes(db,member,prepared.rooms)) !== prepared.authority)
              throw new Error('member stream authority changed');
            while (frameIndex < prepared.encoded.length && writable && !stopped) {
              const frame=prepared.encoded[frameIndex]!;
              let end=Math.min(frame.length,offset+32*1024);
              const unit=frame.charCodeAt(end-1);
              if(end<frame.length&&unit>=0xd800&&unit<=0xdbff)end--;
              writable=response.write(frame.slice(offset,end));
              offset=end;
              if(offset>=frame.length){frameIndex++;offset=0;}
            }
          });
          if (!writable && !stopped) await new Promise<void>(resolve => {
            const done = () => { response.off('drain',done); response.off('close',done); resolve(); };
            response.once('drain',done); response.once('close',done);
            if (response.destroyed || response.writableEnded || !response.writableNeedDrain) done();
          });
        }
        if (!continuing) {position=prepared.to;wakeAfter=undefined;catchupCut=undefined;if('newer' in prepared&&prepared.newer)dirty=true;}
        mentionCursor=prepared.after; initial=false;
        if (continuing) dirty=true;
      }
    } catch { close('unavailable'); } finally { running=false; }
  };
  await drain();
}
