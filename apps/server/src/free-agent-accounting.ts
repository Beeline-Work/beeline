import type { SqlDatabase } from './database.js';
import type { FreeAgentConfig } from './free-agents.js';
import { CommandRefusalError } from './command-refusal.js';
import { DEFAULT_FREE_AGENT_LIMITS, type FreeAgentLimits } from './free-agent-limits.js';

export const DEFAULT_OUTPUT_RESERVATION = 8_192;
type Limit = 'daily' | 'lifetime' | 'budget' | 'rate';
type Allocation = { reserved: number; maxOutput: number; credit: number; limit?: Limit | null };
type Reservation = Omit<Allocation, 'limit'> & { reservedUsd: number };
export class AllowanceRefusal extends CommandRefusalError {
  constructor(readonly limit: Limit) { super('Owned model allowance is unavailable', limit === 'rate' ? 429 : 403); }
}

// PostgreSQL 16 RETURNING exposes the new row. Retain the exact last grant
// alongside each counter so a waiter returns its own allocation, including a
// partial grant, rather than subtracting a stale pre-update snapshot.
export const FREE_AGENT_ACCOUNTING_SCHEMA = `
ALTER TABLE free_agent_call_rate ADD COLUMN IF NOT EXISTS lifetime_tokens bigint;
ALTER TABLE free_agent_call_rate ADD COLUMN IF NOT EXISTS last_grant bigint;
ALTER TABLE free_agent_usage ADD COLUMN IF NOT EXISTS allocation jsonb;
ALTER TABLE free_agent_budget ADD COLUMN IF NOT EXISTS allocation jsonb;
`;

function dailyAllocation(tokens: string, credit: string): string {
  return `WITH available AS (
    SELECT GREATEST($5::bigint,$6::bigint-GREATEST(0,32768-${credit})) prompt,
      LEAST($3::bigint-${tokens},$4::bigint) remaining
  ), offer AS (
    SELECT prompt,LEAST($7::bigint,remaining-prompt) output,
      $6::bigint-prompt credit,remaining-prompt room FROM available
  ) SELECT ${tokens}+CASE WHEN room>=256 THEN prompt+output ELSE 0 END,
      ${credit}+CASE WHEN room>=256 THEN credit ELSE 0 END,
      jsonb_build_object('reserved',prompt+output,'maxOutput',output,'credit',credit,
        'limit',CASE WHEN room<256 THEN CASE WHEN $4::bigint<=$3::bigint-${tokens}
          THEN 'lifetime' ELSE 'daily' END END) FROM offer`;
}

function dollarAllocation(usd: string): string {
  return `WITH available AS (
    SELECT floor(($2::numeric-${usd}-$3::numeric)/$4::numeric)::bigint room
  ), offer AS (SELECT LEAST($5::bigint,room) output,room FROM available)
  SELECT ${usd}+CASE WHEN room>=256 THEN $3::numeric+output*$4::numeric ELSE 0 END,
    jsonb_build_object('maxOutput',output,'reservedUsd',$3::numeric+output*$4::numeric,
      'limit',CASE WHEN room<256 THEN 'budget' END) FROM offer`;
}

/** Compose in the caller's transaction. A refusal must escape that transaction
 * so all preceding allocations roll back. No provider runs before COMMIT. */
export async function reserveAllowanceInTransaction(db: SqlDatabase, ownerId: string, now: Date,
  config: Pick<FreeAgentConfig, 'dailyTokenCap' | 'lifetimeTokenCap'>, promptTokens: number,
  requestedOutput: number | undefined, limits: FreeAgentLimits = DEFAULT_FREE_AGENT_LIMITS,
  budgetPromptTokens = promptTokens, promptUpperBound = promptTokens): Promise<Reservation> {
  const day = now.toISOString().slice(0, 10), minute = Math.floor(now.getTime()/60_000);
  const output = Math.floor(Math.min(requestedOutput ?? DEFAULT_OUTPUT_RESERVATION,limits.maxOutputTokens));
  const want = promptUpperBound+Math.max(256,output);
  const prior = `(SELECT COALESCE(SUM(tokens),0) FROM free_agent_usage WHERE owner_id=$1)`;
  const total = `COALESCE(free_agent_call_rate.lifetime_tokens,${prior})`;
  const grant = (used: string) => `GREATEST(0,LEAST($3::bigint,CASE WHEN $4::bigint>0 THEN $4::bigint-${used} ELSE $3::bigint END))`;
  const owner = (await db.query<{ last_grant: string }>(`
    INSERT INTO free_agent_call_rate(owner_id,minute,calls,lifetime_tokens,last_grant)
    VALUES($1,$2,1,${prior}+${grant(prior)},${grant(prior)})
    ON CONFLICT(owner_id) DO UPDATE SET minute=$2,
      calls=CASE WHEN free_agent_call_rate.minute=$2 THEN free_agent_call_rate.calls+1 ELSE 1 END,
      lifetime_tokens=${total}+${grant(total)},last_grant=${grant(total)}
    WHERE free_agent_call_rate.minute<>$2 OR free_agent_call_rate.calls<$5
    RETURNING last_grant`, [ownerId,minute,want,config.lifetimeTokenCap,limits.callsPerMinute])).rows[0];
  if (!owner) throw new AllowanceRefusal('rate');
  const ownerGrant = Number(owner.last_grant);
  const daily = (await db.query<{ allocation: Allocation }>(`
    INSERT INTO free_agent_usage(owner_id,day,tokens,reservation_credit,allocation)
    SELECT $1,$2::date,proposal.* FROM (${dailyAllocation('0::bigint','0::bigint')}) proposal
    ON CONFLICT(owner_id,day) DO UPDATE SET (tokens,reservation_credit,allocation)=
      (${dailyAllocation('free_agent_usage.tokens','free_agent_usage.reservation_credit')})
    RETURNING allocation`, [ownerId,day,config.dailyTokenCap,ownerGrant,promptTokens,promptUpperBound,output])).rows[0]!.allocation;
  if (daily.limit) throw new AllowanceRefusal(daily.limit);
  const shared = (await db.query<{ allocation: { maxOutput: number; reservedUsd: number; limit?: Limit | null } }>(`
    INSERT INTO free_agent_budget(day,usd,allocation)
    SELECT $1::date,proposal.* FROM (${dollarAllocation('0::numeric')}) proposal
    ON CONFLICT(day) DO UPDATE SET (usd,allocation)=(${dollarAllocation('free_agent_budget.usd')})
    RETURNING allocation`, [day,limits.dailyBudgetUsd,budgetPromptTokens*limits.inputUsdPerMillion/1_000_000,
    limits.outputUsdPerMillion/1_000_000,daily.maxOutput])).rows[0]!.allocation;
  if (shared.limit) throw new AllowanceRefusal(shared.limit);
  const reserved = daily.reserved-daily.maxOutput+shared.maxOutput;
  await db.query(`WITH refunded AS (
    UPDATE free_agent_call_rate SET lifetime_tokens=GREATEST(0,lifetime_tokens-$2::bigint)
    WHERE owner_id=$1 RETURNING owner_id
  ) UPDATE free_agent_usage SET tokens=GREATEST(0,tokens-$4::bigint),
      allocation=jsonb_build_object('reserved',$5::bigint,'maxOutput',$6::bigint,'credit',$7::bigint)
    WHERE owner_id=$1 AND day=$3::date AND EXISTS(SELECT 1 FROM refunded)`,
  [ownerId,ownerGrant-reserved,day,daily.reserved-reserved,reserved,shared.maxOutput,daily.credit]);
  return { reserved,maxOutput:shared.maxOutput,reservedUsd:shared.reservedUsd,credit:daily.credit };
}

/** Ordinary standalone admission owns rollback before exposing a refusal. */
export async function reserveAllowance(db: SqlDatabase, ownerId: string, now: Date,
  config: Pick<FreeAgentConfig, 'dailyTokenCap' | 'lifetimeTokenCap'>, promptTokens: number,
  requestedOutput: number | undefined, limits: FreeAgentLimits = DEFAULT_FREE_AGENT_LIMITS,
  budgetPromptTokens = promptTokens, promptUpperBound = promptTokens): Promise<Reservation | { limit: Limit }> {
  try {
    return await db.transaction(tx => reserveAllowanceInTransaction(tx,ownerId,now,config,promptTokens,
      requestedOutput,limits,budgetPromptTokens,promptUpperBound));
  } catch (error) {
    if (error instanceof AllowanceRefusal) return { limit:error.limit };
    throw error;
  }
}

/** One owner→day→shared settlement, with the existing durable usage event. */
export async function settleAllowance(db: SqlDatabase, ownerId: string, agentId: string, day: string,
  tokens: number, credit: number, usd: number, evidence: Record<string, unknown>): Promise<void> {
  await db.query(`WITH owner AS (
    INSERT INTO free_agent_call_rate(owner_id,minute,calls,lifetime_tokens)
    VALUES($1,0,0,GREATEST(0,(SELECT COALESCE(SUM(tokens),0) FROM free_agent_usage WHERE owner_id=$1)+$4::bigint))
    ON CONFLICT(owner_id) DO UPDATE SET lifetime_tokens=GREATEST(0,
      COALESCE(free_agent_call_rate.lifetime_tokens,
        (SELECT COALESCE(SUM(tokens),0) FROM free_agent_usage WHERE owner_id=$1))+$4::bigint)
    RETURNING owner_id
  ), daily AS (
    INSERT INTO free_agent_usage(owner_id,day,tokens,reservation_credit)
    SELECT $1,$3::date,GREATEST(0,$4::bigint),GREATEST(0,$5::bigint) FROM owner
    ON CONFLICT(owner_id,day) DO UPDATE SET tokens=GREATEST(0,free_agent_usage.tokens+$4::bigint),
      reservation_credit=GREATEST(0,free_agent_usage.reservation_credit+$5::bigint)
    RETURNING owner_id
  ), shared AS (
    UPDATE free_agent_budget SET usd=GREATEST(0,usd+$6::numeric)
    WHERE day=$3::date AND EXISTS(SELECT 1 FROM daily) RETURNING day
  ) INSERT INTO free_agent_events(agent_id,kind,detail)
    SELECT $2,'model_usage',$7::jsonb FROM daily`,
  [ownerId,agentId,day,tokens,credit,usd,JSON.stringify(evidence)]);
}
