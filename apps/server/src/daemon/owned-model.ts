import { fenceOwnedTurnReply as enqueueOwnedTurnReply } from '../owned-turn-reply.js';
import { OwnedModelRefusal } from '../owned-model-errors.js';
import { assertCurrentTurnOwner, lockOwnedTurnRoomAccess } from '../turn-ownership.js';
import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';
import { OwnedModelCredentials } from '../owned-model-credential.js';
import type { CommandActivationInput } from '@beeline/api-contract/helper-activation';
import { captureCommandActivation, helperActivationEnabled } from '../helper-activation.js';
import type { StarterOnboardingService } from '../starter-onboarding-run.js';
import { type SqlDatabase } from '../database.js';
import type { DaemonContext } from './context.js';
import { OwnedModelConfiguration, OwnedModelNegotiation, OwnedModelClaimCapability, AccessDeniedError } from './values.js';
import { DaemonService } from '../daemon-service.js';


  /** Root installs this only after schema/signer/helper rollout proof. Absent
   * configuration keeps free-agent claims on their existing legacy path. */
  export function daemonSetOwnedModel(ctx: DaemonContext, configuration: OwnedModelConfiguration | undefined): void { ctx.ownedModel = configuration; }

  export function daemonOwnedModelReady(ctx: DaemonContext): boolean { return ctx.ownedModel?.ready() === true; }


  export async function daemonNegotiateOwnedModel(ctx: DaemonContext, agentId: string, source: HelperTurnOwnershipSource, installed: boolean): Promise<OwnedModelNegotiation> {
    const free = (await ctx.database.query<{ eligible: boolean }>(`SELECT removed_at IS NULL AND state='running'
      AND model_token_hash IS NOT NULL eligible FROM free_agents WHERE agent_id=$1`, [agentId])).rows[0];
    if (!free) return { freeAgent: false };
    const configuration = ctx.ownedModel;
    if (!installed || !free.eligible || !configuration?.ready()) return { freeAgent: true };
    await assertCurrentTurnOwner(ctx.database, agentId, source);
    const capability = Object.freeze({}) as OwnedModelClaimCapability;
    ctx.modelClaims.set(capability, { agentId, source: Object.freeze({ ...source }), configuration });
    return { freeAgent: true, capability };
  }


  export function daemonModelClaimCredentials(ctx: DaemonContext, capability: OwnedModelClaimCapability | undefined, agentId: string,
    source: HelperTurnOwnershipSource): OwnedModelCredentials {
    const claim = capability && ctx.modelClaims.get(capability), configuration = ctx.ownedModel;
    if (!claim || !configuration || claim.configuration !== configuration || !configuration.ready() || claim.agentId !== agentId ||
        claim.source.connectionId !== source.connectionId || claim.source.epoch !== source.epoch) throw new OwnedModelRefusal();
    return configuration.credentials;
  }

  export function daemonSetStarterOnboarding(ctx: DaemonContext, service: StarterOnboardingService): void { ctx.starterOnboarding = service; }


  /** Actual owned database effects share the existing authority writer fence
   * before acquiring source/command rows. No provider runs under this lock. */
  export async function daemonLockOwnedTurnAccess(ctx: DaemonContext, database: SqlDatabase, roomId: string, agentId: string, controlId?: string): Promise<void> {
    if (!await lockOwnedTurnRoomAccess(database, roomId, agentId, controlId)) throw new AccessDeniedError();
  }


  /** Enqueue only the bounded control response under current access/source. */
  export async function daemonFenceOwnedTurnReply(ctx: DaemonContext, agentId: string, source: HelperTurnOwnershipSource, input: { roomId: string; generationId?: string; commandId?: string; requestId?: string }, enqueue: () => void, requireClaimed = false): Promise<void> {
    await enqueueOwnedTurnReply(ctx.database,agentId,source,input,enqueue,requireClaimed);
  }


  /** Narrow DB-only setup path. Every effect still uses execute's current
   * command/grant authorization; this value only replaces duplicate reads. */
  export async function daemonReadCommandActivation(ctx: DaemonContext, input:CommandActivationInput,authenticatedAgentId:string){
    if(!helperActivationEnabled()||input.agentId!==authenticatedAgentId)throw new Error('Activation capability unavailable');
    return captureCommandActivation(ctx.database,input,async(db,command,isCorner)=>{
      const scoped=new DaemonService(db,ctx.live,undefined,ctx.mediaMaximumBytes,true,command);
      const configuration=await scoped.configuration(authenticatedAgentId,input.roomId);
      const roster=await scoped.workspaceRoster({agentId:authenticatedAgentId,workspaceId:input.workspaceId},authenticatedAgentId);
      const grants=await scoped.listAgentGrants(authenticatedAgentId,input.roomId);
      const requester=await scoped.repositoryOnboardingRequester(authenticatedAgentId,input.roomId);
      const repository={...await scoped.repository(input.roomId,authenticatedAgentId),...(requester?{repositoryOnboarding:true}: {})};
      return {configuration,roster,grants,repository,...(isCorner?{corner:await scoped.cornerRestore(input.roomId,authenticatedAgentId)}:{})};
    });
  }
