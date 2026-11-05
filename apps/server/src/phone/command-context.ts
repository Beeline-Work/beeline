import { recordPersonInteraction } from '../away-auto-pause.js';
import { CommandScopedDatabase } from '../command-scoped-database.js';
import type { TrayDecisionOperation } from '../tray-decision-command.js';
import { ROUTER_AUTHORITY_LOCK } from '../router-authority-lock.js';
import { StarterOnboardingService } from '../starter-onboarding-run.js';
import { CornerAccessDatabase } from '../corner-access-database.js';
import { requireScheduledWorkManager } from '../subscription-webhooks.js';
import { deleteRoomSubscription } from '../agent-subscriptions.js';
import { type PhoneOperationMap } from '@beeline/api-contract/phone';
import { type SqlDatabase } from '../database.js';
import type { FreeAgentService } from '../free-agents.js';
import { REVIEW_IDENTITY_ID } from '../review-access.js';
import type { PhoneContext } from './context.js';
import { REVIEW_LOCKED_OPERATIONS } from './operation-names.js';
import { REVIEW_IDENTITY_MESSAGE } from './values.js';
import { phoneDecideAgentGrant } from './agent-configuration.js';
import { Input } from './types.js';
import { phoneExecute } from './execute.js';


  export function phoneSetStarterOnboarding(ctx: PhoneContext, service: StarterOnboardingService): void { ctx.starterOnboarding = service; }


  /** Give every newly created Workspace a free starter agent. */
  export function phoneSetFreeAgents(ctx: PhoneContext, 
    freeAgents: Pick<FreeAgentService, 'createInWorkspace' | 'kick' | 'remove' | 'cleanupRemoved'>,
  ): void {
    ctx.freeAgents = freeAgents;
  }


  export function phoneWithCommandTransaction<T>(ctx: PhoneContext, database: SqlDatabase, work: () => Promise<T>): Promise<T> {
    return (ctx.database as CommandScopedDatabase).run(new CornerAccessDatabase(database), work);
  }


  /** Only the closed durable decision adapter installs this transaction and
   * owns the postcommit notification queue. Legacy callers keep their result
   * and immediate-after-own-transaction notification behavior. */
  export async function phoneApplyTrayDecisionCommand(ctx: PhoneContext, operation: TrayDecisionOperation,
    input: PhoneOperationMap[TrayDecisionOperation]['input'], viewerId: string,
    defer: (notification: () => void) => void): Promise<void> {
    if (!(ctx.database as CommandScopedDatabase).active) throw new Error('Tray decision requires its durable command transaction');
    if (viewerId === REVIEW_IDENTITY_ID && REVIEW_LOCKED_OPERATIONS.has(operation)) throw new Error(REVIEW_IDENTITY_MESSAGE);
    if (operation === 'decideAgentGrant') {
      await phoneDecideAgentGrant(ctx, input as Input<'decideAgentGrant'>, viewerId, defer);
      await recordPersonInteraction(ctx.database, viewerId);
    }
    else if (operation === 'decideWritePermission') await phoneExecute(ctx, operation, input as Input<'decideWritePermission'>, viewerId);
    else if (operation === 'skipChoice') await phoneExecute(ctx, operation, input as Input<'skipChoice'>, viewerId);
    else throw new Error('Unsupported Tray decision command');
  }


  /** New durable stop intents are idempotent desired state. Legacy operations
   * keep their exact not-found response. Provider cleanup never holds the DB
   * connection or authority fence and cannot be automatically replayed. */
  export async function phoneStopScheduledWorkCommand(ctx: PhoneContext, operation:'deleteRoomSchedule'|'deleteRoomSubscription',
    input:{roomId:string;scheduleId?:string;subscriptionId?:string},viewer:string):Promise<void>{
    const authorize=async(db:SqlDatabase)=>{
      await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
      await requireScheduledWorkManager(db,input.roomId,viewer);
      if((await db.query(`SELECT 1 FROM memberships member WHERE member.identity_id=$1 AND member.room_id IS NULL
        AND member.removed_at IS NULL AND member.role='spectator' AND member.workspace_id=(SELECT workspace_id FROM rooms WHERE id=$2)`,[viewer,input.roomId])).rowCount)
        throw new Error('spectator access is read-only (access denied)');
    };
    if(operation==='deleteRoomSchedule'){
      if(!(ctx.database as CommandScopedDatabase).active)throw new Error('Scheduled stop requires its durable command transaction');
      await authorize(ctx.database);
      await ctx.database.query(`DELETE FROM agent_schedules schedule USING rooms surface WHERE schedule.id=$1
        AND surface.id=schedule.room_id AND(surface.id=$2 OR surface.parent_id=$2) AND schedule.workflow_run IS NULL`,[input.scheduleId,input.roomId]);
      return;
    }
    const trigger=await ctx.database.transaction(async db=>{
      await authorize(db);
      const row=(await db.query<{trigger_id:string|null}>(`SELECT subscription.trigger_id FROM agent_subscriptions subscription JOIN rooms surface ON surface.id=subscription.room_id
        WHERE subscription.id::text=$1 AND(surface.id=$2 OR surface.parent_id=$2)`,[input.subscriptionId,input.roomId])).rows[0];
      try{await deleteRoomSubscription(db,input.roomId,input.subscriptionId!,undefined);}
      catch(error){if(!(error instanceof Error)||error.message!=='subscription not found')throw error;}
      if(!row?.trigger_id||/^[0-9a-f-]{36}$/.test(row.trigger_id))return;
      if((await db.query(`SELECT 1 FROM agent_subscriptions WHERE trigger_id=$1 LIMIT 1`,[row.trigger_id])).rowCount)return;
      return row.trigger_id;
    });
    if(trigger&&ctx.composio)await ctx.composio.deleteWebhookTrigger(trigger);
  }
