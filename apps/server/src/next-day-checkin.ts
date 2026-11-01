import { checkinEmailHtml, type EmailAgent } from './checkin-email-html.js';
import { createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { externalFetch } from '@beeline/auth/external-fetch';
import type { SqlDatabase } from './database.js';
import { createAgentCommand } from './agent-command.js';
import { recordOnboardingEvent } from './signin-funnel.js';
import { ExpectedRefusalError } from './command-refusal.js';

/** No identity time zone is stored today; use the approved Eastern fallback. */
export function checkinDueAt(first: Date, timeZone = 'America/New_York'): Date {
  return CronExpressionParser.parse('0 9 * * *', {
    currentDate: new Date(first.getTime() + 12 * 3600_000 - 1), tz: timeZone,
  }).next().toDate();
}

export const NEXT_DAY_CHECKIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS next_day_checkin_candidates (
  identity_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  first_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  processed boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS next_day_candidates_due ON next_day_checkin_candidates(due_at,identity_id) WHERE NOT processed;
CREATE TABLE IF NOT EXISTS next_day_checkins (
  identity_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  agent_id text REFERENCES identities(id) ON DELETE SET NULL,
  command_id text UNIQUE,
  message_id text REFERENCES messages(id) ON DELETE SET NULL,
  sent_at timestamptz,
  skip_reason text,
  email_status text NOT NULL DEFAULT 'pending',
  email_attempted_at timestamptz,
  push_outcomes jsonb NOT NULL DEFAULT '[]',
  measured_at timestamptz
);
CREATE INDEX IF NOT EXISTS next_day_checkins_room ON next_day_checkins(room_id);
CREATE INDEX IF NOT EXISTS next_day_checkins_agent ON next_day_checkins(agent_id);
CREATE INDEX IF NOT EXISTS next_day_checkins_message ON next_day_checkins(message_id);
CREATE INDEX IF NOT EXISTS next_day_checkins_pending ON next_day_checkins(identity_id) WHERE measured_at IS NULL AND skip_reason IS NULL;
CREATE OR REPLACE FUNCTION note_checkin_first_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE morning timestamptz;
BEGIN
  IF NEW.presentation <> 'message' OR NEW.system_event IS NOT NULL OR NEW.deleted_at IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM identities WHERE id=NEW.author_id AND kind='human' AND NOT hidden_from_roster)
    OR EXISTS(SELECT 1 FROM messages WHERE author_id=NEW.author_id AND id<>NEW.id
      AND presentation='message' AND system_event IS NULL) THEN RETURN NEW; END IF;
  morning := ((NEW.created_at AT TIME ZONE 'America/New_York')::date+1+time '09:00') AT TIME ZONE 'America/New_York';
  IF morning < NEW.created_at+interval '12 hours' THEN
    morning := ((morning AT TIME ZONE 'America/New_York')::date+1+time '09:00') AT TIME ZONE 'America/New_York';
  END IF;
  INSERT INTO next_day_checkin_candidates(identity_id,first_at,due_at)
    VALUES(NEW.author_id,NEW.created_at,morning) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS next_day_first_message ON messages;
CREATE TRIGGER next_day_first_message AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION note_checkin_first_message();
-- Serialize all posts for the command, including retries and intermediate tool posts.
CREATE OR REPLACE FUNCTION note_checkin_reply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checkin next_day_checkins;
BEGIN
  IF NEW.request_id IS NULL THEN RETURN NEW; END IF;
  SELECT n.* INTO checkin FROM next_day_checkins n JOIN agent_commands c ON c.id=n.command_id
    WHERE c.turn_request_id=NEW.request_id AND n.agent_id=NEW.author_id AND n.room_id=NEW.room_id FOR UPDATE OF n;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF checkin.skip_reason IS NOT NULL OR checkin.sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'This one-time check-in is already settled';
  END IF;
  -- Daemon telemetry is intermediate output, never the check-in reply.
  -- Keep it behind the same command lock and settlement fence as final output.
  IF NEW.presentation='activity' AND NEW.system_event IS NULL AND NEW.text='' THEN RETURN NEW; END IF;
  IF NEW.presentation<>'message' OR NEW.system_event IS NOT NULL OR btrim(NEW.text)='' THEN
    RAISE EXCEPTION 'A check-in must be one plain Room message';
  END IF;
  UPDATE next_day_checkins SET message_id=NEW.id,sent_at=NEW.created_at WHERE identity_id=checkin.identity_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS next_day_reply ON messages;
CREATE TRIGGER next_day_reply AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION note_checkin_reply();
`;

type Target = { room_id: string | null; agent_id: string | null; handle: string | null; skip_reason: string | null };
async function target(db: SqlDatabase, identity: string, first: Date): Promise<Target> {
  return (await db.query<Target>(`SELECT last.room_id,starter.agent_id,i.handle,
    CASE WHEN i.hidden_from_roster OR lower(btrim(i.handle,'@'))=ANY($3::text[])
      OR EXISTS(SELECT 1 FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
        WHERE m.identity_id=i.id AND w.internal) THEN 'internal'
    WHEN EXISTS(SELECT 1 FROM messages back WHERE back.author_id=i.id AND back.presentation='message'
      AND back.system_event IS NULL AND back.created_at >= $2::timestamptz+interval '6 hours'
      AND (back.created_at AT TIME ZONE 'America/New_York')::date > ($2::timestamptz AT TIME ZONE 'America/New_York')::date) THEN 'returned'
    WHEN last.room_id IS NULL OR r.archived_at IS NOT NULL OR r.parent_id IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM memberships m WHERE m.room_id=last.room_id AND m.identity_id=i.id AND m.removed_at IS NULL)
      OR NOT EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=r.workspace_id AND m.room_id IS NULL
        AND m.identity_id=i.id AND m.removed_at IS NULL) THEN 'left_room'
    WHEN starter.agent_id IS NULL THEN 'starter_removed' END skip_reason
    FROM identities i LEFT JOIN LATERAL (
      SELECT room_id FROM messages WHERE author_id=i.id AND presentation='message' AND system_event IS NULL
      ORDER BY created_at DESC,id DESC LIMIT 1) last ON true
    LEFT JOIN rooms r ON r.id=last.room_id
    LEFT JOIN LATERAL (SELECT f.agent_id FROM free_agents f JOIN memberships m ON m.identity_id=f.agent_id
      AND m.room_id=last.room_id AND m.removed_at IS NULL
      WHERE f.owner_id=i.id AND f.workspace_id=r.workspace_id AND f.starter_role IS NOT NULL AND f.removed_at IS NULL
      ORDER BY (f.starter_role='beebee') DESC,f.created_at,f.agent_id LIMIT 1) starter ON true
    WHERE i.id=$1`, [identity,first,['lunchboxfortwo','bananaman614305','moonscannerai','play-review']])).rows[0]
    ?? { room_id: null, agent_id: null, handle: null, skip_reason: 'identity_removed' };
}

const enabled = () => process.env.BEELINE_NEXT_DAY_CHECKIN !== 'off';

/** Called before a generated reply is accepted, so switching off also fences in-flight turns. */
export async function checkinOutputAllowed(db: SqlDatabase, roomId: string, agentId: string, requestId: unknown,
  output?: { text: string; presentation?: string }): Promise<boolean> {
  if (typeof requestId !== 'string') return true;
  const row = (await db.query<{ identity_id: string; first_at: Date; skip_reason: string | null; sent_at: Date | null }>(
    `SELECT n.identity_id,p.first_at,n.skip_reason,n.sent_at FROM next_day_checkins n
     JOIN next_day_checkin_candidates p USING(identity_id) JOIN agent_commands c ON c.id=n.command_id
     WHERE c.turn_request_id=$1 AND n.room_id=$2 AND n.agent_id=$3`, [requestId,roomId,agentId])).rows[0];
  if (!row) return true;
  if (row.sent_at || row.skip_reason) return false;
  if (output && (!output.text.trim() || (output.presentation !== undefined && output.presentation !== 'message')))
    throw new ExpectedRefusalError('A check-in must be one plain Room message. Post nonempty text with message presentation.');
  const current = await target(db,row.identity_id,new Date(row.first_at));
  return enabled() && !current.skip_reason && current.room_id===roomId && current.agent_id===agentId;
}

export type CheckinEmail = { to: string; subject: string; text: string; html: string; key: string };
export function renderCheckinEmail(agentName: string, text: string, url: string, agents: EmailAgent[] = [], imageOrigin = 'https://server.usebeeline.app') {
  return { subject: `${agentName} picked up where you left off`,
    text: `${text}\n\nOpen in Beeline: ${url}\n\nThis is a one-time note from your starter agent.`,
    html: checkinEmailHtml(agentName,text,url,agents,imageOrigin) };
}
async function sendEmail(mail: CheckinEmail): Promise<string> {
  const key = process.env.BEELINE_EMAIL_API_KEY, from = process.env.BEELINE_EMAIL_FROM;
  if (!key || !from) return 'unconfigured';
  const response = await externalFetch('https://api.resend.com/emails', { method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': mail.key },
    body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
    signal: AbortSignal.timeout(10_000) });
  return response.ok ? 'sent' : `failed_http_${response.status}`;
}

export class NextDayCheckin {
  constructor(private readonly db: SqlDatabase, private readonly webOrigin: string,
    private readonly email: (mail: CheckinEmail) => Promise<string> = sendEmail,
    private readonly now: () => Date = () => new Date(),
    private readonly imageOrigin = 'https://server.usebeeline.app') {}

  async runOnce(): Promise<void> {
    if (!enabled()) return;
    const candidates = (await this.db.query<{ identity_id: string }>(
      `SELECT identity_id FROM next_day_checkin_candidates WHERE NOT processed AND due_at<=$1
       ORDER BY due_at,identity_id LIMIT 25`, [this.now()])).rows;
    for (const { identity_id } of candidates) await this.db.transaction(async db => {
      const candidate = (await db.query<{ first_at: Date; due_at: Date }>(
        `SELECT first_at,due_at FROM next_day_checkin_candidates WHERE identity_id=$1 AND NOT processed FOR UPDATE SKIP LOCKED`, [identity_id])).rows[0];
      if (!candidate || !enabled()) return;
      const person = await target(db,identity_id,new Date(candidate.first_at));
      const commandId = createHash('sha256').update(`next-day-checkin:${identity_id}`).digest('hex');
      const claimed = await db.query(`INSERT INTO next_day_checkins(identity_id,due_at,room_id,agent_id,command_id,skip_reason)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING identity_id`,
        [identity_id,candidate.due_at,person.room_id,person.agent_id,commandId,person.skip_reason]);
      await db.query(`UPDATE next_day_checkin_candidates SET processed=true WHERE identity_id=$1`, [identity_id]);
      if (!claimed.rowCount || person.skip_reason) return;
      const command = await createAgentCommand(db,{ id: commandId,roomId:person.room_id!,agentId:person.agent_id!,
        sourceMessageId:null,reason:'free_agent_checkin' });
      if (command) await db.query(`UPDATE agent_commands SET wake_context=jsonb_build_object('checkinPrompt',$2::text) WHERE id=$1`, [command.id,
          `Write exactly one short check-in message to ${person.handle ? '@'+person.handle : 'this person'} in this Room. `+
          `Use only this Room's visible messages to name what they were doing when they stopped. Offer exactly one concrete next step. `+
          `Do not guess private context. This is their one-time next-morning check-in. Post one plain message only; no other posts or agent tags.` ]);
      if (!command) await db.query(`UPDATE next_day_checkins SET skip_reason='dispatch_unavailable' WHERE identity_id=$1`, [identity_id]);
    });
    const pending = (await this.db.query<{ identity_id: string; first_at: Date; due_at: Date; command_state: string | null; room_id: string; agent_id: string; command_id: string;
      message_id: string | null; sent_at: Date | null; email_status: string; text: string | null; name: string; workspace_id: string;
      email: string | null }>(`SELECT n.*,p.first_at,m.text,i.name,r.workspace_id,c.state command_state,
        (SELECT provider_login FROM identity_external_links WHERE identity_id=n.identity_id AND provider='google'
          AND provider_login LIKE '%@%' ORDER BY created_at LIMIT 1) email
        FROM next_day_checkins n JOIN next_day_checkin_candidates p USING(identity_id)
        LEFT JOIN messages m ON m.id=n.message_id LEFT JOIN identities i ON i.id=n.agent_id
        LEFT JOIN agent_commands c ON c.id=n.command_id
        LEFT JOIN rooms r ON r.id=n.room_id WHERE n.skip_reason IS NULL AND n.measured_at IS NULL
        ORDER BY (n.sent_at IS NOT NULL AND n.email_status='pending') DESC,n.due_at,n.identity_id LIMIT 25`)).rows;
    for (const row of pending) {
      if (!enabled()) return;
      if (!row.sent_at) {
        const current = await target(this.db,row.identity_id,new Date(row.first_at));
        const skip = current.skip_reason ?? (current.room_id!==row.room_id || current.agent_id!==row.agent_id ? 'room_changed'
          : !row.command_state || ['complete','cancelled'].includes(row.command_state) ? 'agent_no_message'
          : this.now().getTime()-new Date(row.due_at).getTime() > 24*3600_000 ? 'agent_timeout' : null);
        if (skip) {
          await this.db.query(`UPDATE next_day_checkins SET skip_reason=$2 WHERE identity_id=$1 AND sent_at IS NULL`,
            [row.identity_id,skip]);
          await this.db.query(`UPDATE agent_commands SET state='cancelled',completed_at=now() WHERE id=$1 AND state IN ('pending','claimed')`, [row.command_id]);
        }
        continue;
      }
      // Commit the email attempt before HTTP. An uncertain/crashed send is never retried.
      // The provider idempotency key adds protection without relying on its retention window.
      if (row.email_status==='pending') {
        const attempt = await this.db.query(`UPDATE next_day_checkins SET email_status=$2,email_attempted_at=$3
          WHERE identity_id=$1 AND email_status='pending' RETURNING identity_id`,
          [row.identity_id,row.email ? 'attempting' : 'no_address',row.email ? this.now() : null]);
        if (attempt.rowCount && row.email && enabled()) {
          const url = new URL(`/beeline/chat/${row.room_id}`,this.webOrigin);
          url.searchParams.set('communityId',row.workspace_id);
          let status: string;
          try {
            const agents = (await this.db.query<EmailAgent>(`SELECT DISTINCT i.id,i.name FROM free_agents f
              JOIN identities i ON i.id=f.agent_id JOIN memberships m ON m.identity_id=f.agent_id
              AND m.room_id=$2 AND m.removed_at IS NULL
              WHERE f.owner_id=$1 AND f.workspace_id=$3 AND f.starter_role IS NOT NULL AND f.removed_at IS NULL
              AND NOT i.hidden_from_roster ORDER BY i.id`, [row.identity_id,row.room_id,row.workspace_id])).rows;
            // Lead with the speaker, regardless of roster order or duplicate display names.
            agents.sort((a,b) => Number(b.id===row.agent_id)-Number(a.id===row.agent_id));
            status = await this.email({ to:row.email,key:`next-day-${row.identity_id}`,
            ...renderCheckinEmail(row.name,row.text!,url.href,agents,this.imageOrigin) }); } catch { status='failed_or_uncertain'; }
          await this.db.query(`UPDATE next_day_checkins SET email_status=$2 WHERE identity_id=$1`,[row.identity_id,status]);
        }
      }
      await this.db.query(`UPDATE next_day_checkins SET push_outcomes=COALESCE((
        SELECT jsonb_agg(jsonb_build_object('platform',d.platform,'status',COALESCE(c.status,q.reason,'queued')))
        FROM push_devices d LEFT JOIN push_delivery_claims c ON c.device_token=d.token AND c.message_id=$2
        LEFT JOIN push_outbox_retirements q ON q.device_token=d.token AND q.message_id=$2
        WHERE d.identity_id=$1 AND d.registered_at<=$3),'[]'::jsonb) WHERE identity_id=$1`, [row.identity_id,row.message_id,row.sent_at]);
      // Keep observing until the normal push worker records an outcome (or its one-hour window expires).
      if (this.now().getTime()-new Date(row.sent_at).getTime() < 3600_000 && (await this.db.query(
        `SELECT 1 FROM push_devices d LEFT JOIN push_delivery_claims c ON c.device_token=d.token AND c.message_id=$2
         WHERE d.identity_id=$1 AND d.registered_at<=$3 AND (c.status IS NULL OR c.status IN ('claimed','retryable')) LIMIT 1`,
        [row.identity_id,row.message_id,row.sent_at])).rowCount) continue;
      await recordOnboardingEvent(this.db,row.identity_id,'next_day_checkin_sent');
      await this.db.query(`UPDATE next_day_checkins SET measured_at=$2 WHERE identity_id=$1`,[row.identity_id,this.now()]);
    }
  }
}
