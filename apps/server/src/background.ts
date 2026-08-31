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
    const candidates = await this.database.query<{
      message_id: string;
      room_id: string;
      text: string;
      token: string;
    }>(`
      SELECT m.id message_id,m.room_id,m.text,d.token
      FROM messages m
      JOIN memberships member ON member.room_id=m.room_id AND member.removed_at IS NULL AND member.identity_id<>m.author_id
      JOIN push_devices d ON d.identity_id=member.identity_id
      LEFT JOIN push_delivery_claims claim ON claim.message_id=m.id AND claim.device_token=d.token
      WHERE claim.message_id IS NULL
      ORDER BY m.created_at,m.id LIMIT 100
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
  await database.query(`DELETE FROM live_outputs WHERE updated_at<now()-interval '2 hours'`);
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
