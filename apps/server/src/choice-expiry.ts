import type { SqlDatabase } from './database.js';
import { closeExpiredChoices } from './room-choice.js';

/** The background owner's initialization, exact committed choice source, or
 * current minimum deadline admits this batch. Failure never creates a deadline. */
export class ChoiceExpiryLoop {
  constructor(private readonly database: SqlDatabase) {}

  async runOnce(): Promise<number | undefined> {
    await closeExpiredChoices(this.database);
    const next = (await this.database.query<{ delay_ms: number }>(
      `SELECT EXTRACT(epoch FROM (closes_at-clock_timestamp()))::double precision*1000 delay_ms
       FROM room_choices WHERE status='open' AND closes_at IS NOT NULL ORDER BY closes_at,id LIMIT 1`,
    )).rows[0]?.delay_ms;
    if (next === undefined) return undefined;
    if (!Number.isFinite(Number(next))) throw new Error('Invalid choice expiry');
    return Math.max(0, Math.ceil(Number(next)));
  }
}
