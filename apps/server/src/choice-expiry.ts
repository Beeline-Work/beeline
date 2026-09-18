import type { SqlDatabase } from './database.js';
import { closeExpiredChoices } from './room-choice.js';

const CHOICE_SWEEP_INTERVAL_MS = 5_000;

/** Server-owned close for open choices whose `closes_at` has passed. */
export class ChoiceExpiryLoop {
  #lastSweep = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly database: SqlDatabase,
    private readonly intervalMs = CHOICE_SWEEP_INTERVAL_MS,
  ) {}

  async runOnce(now = Date.now()): Promise<number> {
    if (now - this.#lastSweep < this.intervalMs) return 0;
    this.#lastSweep = now;
    return closeExpiredChoices(this.database, new Date(now));
  }
}
