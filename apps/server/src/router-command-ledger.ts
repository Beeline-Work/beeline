import { createHash } from 'node:crypto';
import type { RouterCommandReceipt, RouterCommandCoverage } from '@beeline/api-contract/router-command';
import type { SqlDatabase } from './database.js';
import { ExpectedRefusalError } from './command-refusal.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion, subscribeCommandCompletion,
  waitForCommittedChange, type CommandCompletionKey } from './command-completion.js';

/** Full results expire, used identity/digest rows do not. No FK cascade may
 * remove these fences while a principal can authenticate. Account cleanup
 * must permanently invalidate every credential before deleting its fences. */
export const ROUTER_COMMAND_SCHEMA = `
CREATE TABLE IF NOT EXISTS router_commands (
 principal text NOT NULL,
 operation text NOT NULL,
 command_id text NOT NULL,
 digest text NOT NULL CHECK (length(digest)=64),
 state text NOT NULL CHECK (state IN ('pending','committed','unknown')),
 result jsonb,
 coverage jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 result_expires_at timestamptz,
 PRIMARY KEY(principal,operation,command_id)
);
ALTER TABLE router_commands ADD COLUMN IF NOT EXISTS coverage jsonb;
CREATE INDEX IF NOT EXISTS router_commands_result_expiry_idx
 ON router_commands(result_expires_at) WHERE result IS NOT NULL;
`;

export class CommandDigestConflict extends ExpectedRefusalError {
  constructor() { super('command_identity_conflict'); }
}
export class InvalidCommandArguments extends ExpectedRefusalError {
  constructor() { super('invalid_command_arguments'); }
}
function canonical(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > 64) throw new InvalidCommandArguments();
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidCommandArguments();
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new InvalidCommandArguments();
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new InvalidCommandArguments();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new InvalidCommandArguments();
        items.push(canonical(value[index], seen, depth + 1));
      }
      return '[' + items.join(',') + ']';
    }
    return '{' + Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key], seen, depth + 1)).join(',') + '}';
  } finally { seen.delete(value); }
}
/** Domain/version prefix prevents another normalization scheme reusing an id. */
export function commandArgumentDigest(operation: string, args: unknown): string {
  const encoded = canonical({ schema: 1, operation, args }, new Set(), 0);
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new InvalidCommandArguments();
  return createHash('sha256').update('beeline-command:canonical-v1\n').update(encoded).digest('hex');
}
interface Row { digest: string; state: 'pending' | 'committed' | 'unknown'; result: unknown; coverage: RouterCommandCoverage | null; expired: boolean }
export class RouterCommandLedger {
  constructor(private readonly database: SqlDatabase) {}
  private async inspect(db: SqlDatabase, key: CommandCompletionKey, digest: string): Promise<RouterCommandReceipt> {
    const row = (await db.query<Row>(`SELECT digest,state,result,coverage,
      COALESCE(result_expires_at<=now(),false) expired FROM router_commands
      WHERE principal=$1 AND operation=$2 AND command_id=$3`, [key.principal, key.operation, key.commandId])).rows[0];
    if (!row) throw new Error('durable command claim disappeared');
    if (row.digest !== digest) throw new CommandDigestConflict();
    return { v: 1, operation: key.operation, commandId: key.commandId,
      state: row.state === 'committed' && row.expired ? 'result-expired' : row.state,
      ...(row.state === 'committed' && !row.expired ? { result: row.result, ...(row.coverage ? { coverage: row.coverage } : {}) } : {}) };
  }
  private async claim(db: SqlDatabase, key: CommandCompletionKey, digest: string): Promise<boolean> {
    return (await db.query(`INSERT INTO router_commands(principal,operation,command_id,digest,state)
      VALUES($1,$2,$3,$4,'pending') ON CONFLICT(principal,operation,command_id) DO NOTHING RETURNING command_id`,
      [key.principal, key.operation, key.commandId, digest])).rowCount > 0;
  }
  private async complete(db: SqlDatabase, key: CommandCompletionKey, digest: string, result: unknown, coverage?: RouterCommandCoverage): Promise<RouterCommandReceipt> {
    // JSON serialization failure rolls back an atomic effect. Provider results
    // require an explicit sanitized adapter before entering this ledger.
    const encoded = JSON.stringify(result ?? null);
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error('command result exceeds durable receipt limit');
    await db.query(`UPDATE router_commands SET state='committed',result=$5::jsonb,coverage=$6::jsonb,
      completed_at=now(),result_expires_at=now()+interval '30 days'
      WHERE principal=$1 AND operation=$2 AND command_id=$3 AND digest=$4 AND state='pending'`,
      [key.principal, key.operation, key.commandId, digest, encoded, coverage ? JSON.stringify(coverage) : null]);
    await db.query('SELECT pg_notify($1,$2)', [COMMAND_COMPLETION_CHANNEL, JSON.stringify(key)]);
    return { v: 1, operation: key.operation, commandId: key.commandId, state: 'committed', result: result ?? null, ...(coverage ? { coverage } : {}) };
  }
  /** Uniqueness contention is PostgreSQL-owned, across both servers. Claim,
   * effect, receipt and source triggers share exactly one commit/rollback. */
  async atomic<Result>(key: CommandCompletionKey, args: unknown,
    effect: (transaction: SqlDatabase) => Promise<Result>,
    cover?: (transaction: SqlDatabase, result: Result) => Promise<RouterCommandCoverage>): Promise<RouterCommandReceipt<Result>> {
    const digest = commandArgumentDigest(key.operation, args);
    const receipt = await this.database.transaction(async tx => {
      if (!await this.claim(tx, key, digest)) return this.inspect(tx, key, digest);
      const result = await effect(tx);
      return this.complete(tx, key, digest, result, cover ? await cover(tx, result) : undefined);
    });
    notifyCommandCompletion(key);
    return receipt as RouterCommandReceipt<Result>;
  }
  /** A conservative adapter for effects without a proven provider replay key.
   * Claim commits before dispatch. Any error/crash leaves UNKNOWN/PENDING and
   * retries only observe it; they never dispatch again. This is at-most-once
   * dispatch, not an exactly-once external delivery guarantee. */
  async external<Result>(key: CommandCompletionKey, args: unknown,
    effect: () => Promise<Result>,
    cover?: (transaction: SqlDatabase, result: Result) => Promise<RouterCommandCoverage>): Promise<RouterCommandReceipt<Result>> {
    const digest = commandArgumentDigest(key.operation, args);
    const claimed = await this.database.transaction(tx => this.claim(tx, key, digest));
    if (!claimed) return this.inspect(this.database, key, digest) as Promise<RouterCommandReceipt<Result>>;
    try {
      const result = await effect();
      const receipt = await this.database.transaction(async tx => this.complete(tx, key, digest, result, cover ? await cover(tx, result) : undefined));
      notifyCommandCompletion(key);
      return receipt as RouterCommandReceipt<Result>;
    } catch (error) {
      await this.database.transaction(async tx => {
        await tx.query(`UPDATE router_commands SET state='unknown'
          WHERE principal=$1 AND operation=$2 AND command_id=$3 AND digest=$4 AND state='pending'`,
          [key.principal, key.operation, key.commandId, digest]);
        await tx.query('SELECT pg_notify($1,$2)', [COMMAND_COMPLETION_CHANNEL, JSON.stringify(key)]);
      });
      notifyCommandCompletion(key);
      throw error;
    }
  }
  /** Caller supplies the immutable original args, never a digest from the wire. */
  wait(key: CommandCompletionKey, args: unknown, timeoutMs = 15_000, signal?: AbortSignal) {
    const digest = commandArgumentDigest(key.operation, args);
    return waitForCommittedChange(listener => subscribeCommandCompletion(key, listener), async () => {
      const receipt = await this.inspect(this.database, key, digest);
      return receipt.state === 'pending' ? undefined : receipt;
    }, timeoutMs, signal);
  }
  /** Bounded result compaction retains the permanent identity/digest fence. */
  async compactResults(limit = 1000): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid compaction limit');
    return (await this.database.query(`WITH expired AS (
      SELECT principal,operation,command_id FROM router_commands
      WHERE result_expires_at<=now() AND result IS NOT NULL
      ORDER BY result_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE router_commands command SET result=NULL,coverage=NULL FROM expired
      WHERE command.principal=expired.principal AND command.operation=expired.operation
        AND command.command_id=expired.command_id`, [limit])).rowCount;
  }
}
