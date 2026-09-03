import type { SqlDatabase } from './database.js';

const BACKGROUND_LOCK_KEY = 0x0bee11;

export interface PushSender {
  send(token: string, message: { messageId: string; roomId: string; text: string }): Promise<void>;
}

export class PushDeliveryLoop {
  constructor(
    private readonly database: SqlDatabase,
    private readonly sender: PushSender,
  ) {}

  async runOnce(): Promise<number> {
    // A newly enabled worker must start from its own durable boundary rather than
    // claiming the Room backlog that existed before delivery was enabled.
    await this.database.query(
      `INSERT INTO push_delivery_floors(id) VALUES('message-delivery') ON CONFLICT(id) DO NOTHING`,
    );
    const candidates = await this.database.query<{
      message_id: string;
      room_id: string;
      text: string;
      token: string;
    }>(`
      WITH candidates AS (
        SELECT m.id message_id,m.room_id::text room_id,
          CASE
            WHEN m.card_type='daemon-fact' AND m.card->>'type'='corner-open'
              THEN concat_ws(' ',COALESCE(NULLIF(author.name,''),'An agent'),'opened a corner:',m.card->>'objective')
            WHEN m.card_type='daemon-fact' AND m.card->>'type'='corner-complete'
              THEN concat_ws(' ',COALESCE(NULLIF(author.name,''),'An agent'),
                CASE WHEN m.card->>'outcome'='landed' THEN 'merged:' ELSE 'closed:' END,m.card->>'objective')
            WHEN m.card_type='grant-request' THEN btrim(m.text)
            ELSE concat_ws(': ',COALESCE(NULLIF(author.name,''),'Someone'),btrim(m.text))
          END text,
          d.token,m.created_at
        FROM messages m
        JOIN rooms room ON room.id=m.room_id
        JOIN memberships member ON member.room_id=m.room_id AND member.removed_at IS NULL
          AND member.identity_id<>m.author_id
        JOIN push_devices d ON d.identity_id=member.identity_id
        JOIN identities author ON author.id=m.author_id
        JOIN identities recipient ON recipient.id=member.identity_id AND recipient.kind='human'
        JOIN push_delivery_floors floor ON floor.id='message-delivery'
        WHERE m.created_at>=d.registered_at AND m.created_at>=floor.started_at
          AND m.presentation IS DISTINCT FROM 'activity'
          AND m.card_type IS DISTINCT FROM 'agent-yolo'
          AND m.card_type IS DISTINCT FROM 'turn-failed'
          AND (
            m.mention_ids @> jsonb_build_array(member.identity_id)
            OR room.direct_participants IS NOT NULL
            OR (m.card_type='daemon-fact' AND m.card->>'type' IN ('corner-open','corner-complete'))
          )
          AND (
            btrim(m.text)<>''
            OR (m.card_type='daemon-fact' AND m.card->>'type' IN ('corner-open','corner-complete'))
          )
        UNION ALL
        SELECT notification.id message_id,
          COALESCE(notification.room_id::text,notification.workspace_id::text) room_id,
          btrim(notification.text) text,device.device_token token,notification.created_at
        FROM workspace_join_notifications notification
        JOIN workspace_join_notification_devices device ON device.notification_id=notification.id
        JOIN push_devices push_device ON push_device.token=device.device_token
        JOIN push_delivery_floors floor ON floor.id='message-delivery'
        WHERE notification.created_at>=push_device.registered_at
          AND notification.created_at>=floor.started_at
          AND btrim(notification.text)<>''
      )
      SELECT candidate.message_id,candidate.room_id,candidate.text,candidate.token
      FROM candidates candidate
      LEFT JOIN push_delivery_claims claim
        ON claim.message_id=candidate.message_id AND claim.device_token=candidate.token
      WHERE claim.message_id IS NULL
      ORDER BY candidate.created_at,candidate.message_id LIMIT 100
    `);
    let delivered = 0;
    for (const candidate of candidates.rows) {
      const claim = await this.database.query(
        `INSERT INTO push_delivery_claims(message_id,device_token,status) VALUES($1,$2,'claimed') ON CONFLICT DO NOTHING`,
        [candidate.message_id, candidate.token],
      );
      if (!claim.rowCount) continue;
      try {
        await this.sender.send(candidate.token, {
          messageId: candidate.message_id,
          roomId: candidate.room_id,
          text: candidate.text,
        });
        await this.database.query(
          `UPDATE push_delivery_claims SET status='delivered',completed_at=now() WHERE message_id=$1 AND device_token=$2`,
          [candidate.message_id, candidate.token],
        );
        delivered += 1;
      } catch (error) {
        await this.database.query(
          `UPDATE push_delivery_claims SET status='failed',completed_at=now(),error=$3 WHERE message_id=$1 AND device_token=$2`,
          [
            candidate.message_id,
            candidate.token,
            error instanceof Error ? error.message : String(error),
          ],
        );
      }
    }
    return delivered;
  }
}

export async function runMaintenance(database: SqlDatabase): Promise<void> {
  await database.query(`DELETE FROM phone_access_tokens WHERE expires_at<now()`);
  await database.query(`DELETE FROM phone_sessions WHERE expires_at<now()`);
  await database.query(
    `DELETE FROM live_outputs WHERE updated_at<now()-interval '2 hours'
       AND NOT (kind='presence' AND turn_id='legacy')`,
  );
  await database.query(`DELETE FROM github_auth_flows WHERE expires_at<now()-interval '1 day'`);
  await database.query(
    `DELETE FROM daemon_token_exchanges WHERE expires_at<now()-interval '1 day'`,
  );
}

/**
 * Exactly one process owns background work. PostgreSQL releases the advisory
 * lock automatically when this dedicated connection dies, allowing its peer
 * to acquire it without a queue, worker process, or lease clock.
 */
export class BackgroundLeader {
  #stopped = false;
  #client: LeaderConnection | undefined;

  constructor(
    private readonly database: { connectDedicated(): Promise<LeaderConnection> },
    private readonly cycle: () => Promise<void>,
    private readonly intervalMs = 1_000,
  ) {}

  async run(): Promise<void> {
    while (!this.#stopped) {
      try {
        const client = await this.database.connectDedicated();
        this.#client = client;
        const lock = await client.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock($1) locked`,
          [BACKGROUND_LOCK_KEY],
        );
        if (!lock.rows[0]?.locked) {
          client.release();
          this.#client = undefined;
          await this.wait();
          continue;
        }
        while (!this.#stopped) {
          await client.query('SELECT 1');
          await this.cycle();
          await this.wait();
        }
      } catch {
        await this.wait();
      } finally {
        this.#client?.release(true);
        this.#client = undefined;
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#client?.release(true);
    this.#client = undefined;
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.intervalMs));
  }
}

export interface LeaderConnection {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  release(destroy?: boolean): void;
}
