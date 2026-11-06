import { restoreRoomMembership } from '../membership-join.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { modelChoiceLabel } from '@beeline/api-contract/phone';
import { renderAgentAvatar } from '../agent-avatar.js';
import { createHash, randomUUID } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { directMessageRoomId, ensureSystemDirectMessageRoom, systemLine } from '../system-line.js';
import type { DaemonContext } from './context.js';
import { Input, id } from './values.js';
import { daemonWriteResult } from './corner-messages.js';


  export async function daemonPostMandate(ctx: DaemonContext, input: Input<'postAgentToolMandate'>, agentId: string) {
    await ctx.database.query(
      `INSERT INTO agent_mandates(agent_id,room_id,generation,mandate) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(agent_id,room_id) DO UPDATE SET generation=EXCLUDED.generation,mandate=EXCLUDED.mandate,updated_at=now()`,
      [agentId, input.roomId, input.generation, JSON.stringify(input.mandate)],
    );
    return daemonWriteResult(ctx);
  }

  export async function daemonAgentAvatar(ctx: DaemonContext, input: Input<'postAgentAvatar'>, agentId: string) {
    const command = ctx.authorizedCommand;
    if (!ctx.commandTransaction || !command) throw new Error('avatar requires an active command');
    // Soul edits lock the agent before its identity; use the same order.
    await ctx.database.query('SELECT agent_id FROM agents WHERE agent_id=$1 FOR UPDATE', [
      agentId,
    ]);
    const ownerRequest = await ctx.database.query(
      `SELECT 1 FROM agents a JOIN messages m ON m.author_id=a.owner_id
      WHERE a.agent_id=$1 AND m.id=$2`,
      [agentId, command.root_source_message_id],
    );
    if (!ownerRequest.rowCount)
      throw new Error('only the agent owner may generate its avatar (access denied)');
    const bytes = await renderAgentAvatar(input.drawing);
    const id = randomUUID();
    const avatar = `/v1/agent-avatars/${id}`;
    await ctx.database.query(
      `INSERT INTO agent_avatars(id,agent_id,bytes,request_id,drawing) VALUES($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT(agent_id) DO UPDATE SET id=EXCLUDED.id,bytes=EXCLUDED.bytes,
         request_id=EXCLUDED.request_id,drawing=EXCLUDED.drawing,generated_at=now()`,
      [id, agentId, bytes, command.turn_request_id, JSON.stringify(input.drawing)],
    );
    await ctx.database.query('UPDATE identities SET avatar=$2,updated_at=now() WHERE id=$1', [
      agentId,
      avatar,
    ]);
    await ctx.database.query(
      `UPDATE agents SET soul=CASE WHEN soul IS NULL THEN NULL ELSE soul - 'avatar' END,updated_at=now() WHERE agent_id=$1`,
      [agentId],
    );
    const request = (
      await ctx.database.query<{ workspace_id: string; author_id: string }>(
        `SELECT r.workspace_id,m.author_id FROM messages m JOIN rooms r ON r.id=m.room_id
       JOIN identities i ON i.id=m.author_id AND i.kind='human'
       JOIN memberships wm ON wm.workspace_id=r.workspace_id AND wm.identity_id=m.author_id
         AND wm.room_id IS NULL AND wm.removed_at IS NULL
       WHERE m.id=$1`,
        [command.source_message_id],
      )
    ).rows[0];
    if (request) {
      const participants = [agentId, request.author_id].sort() as [string, string];
      const roomId = directMessageRoomId(request.workspace_id, participants);
      await ctx.database.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,direct_participants)
        VALUES($1,$2,$3,'Direct message','invite-only',$4::jsonb) ON CONFLICT DO NOTHING`,
        [roomId, request.workspace_id, request.author_id, JSON.stringify(participants)],
      );
      for (const participant of participants)
        await restoreRoomMembership(ctx.database, [request.workspace_id, roomId, participant]);
      await systemLine(ctx.database, {
        roomId,
        subject: { kind: 'agent', id: agentId, name: systemMessage("daemon-service.your-agent") },
        verb: systemMessage("daemon-service.saved-its-avatar"),
        consequence: systemMessage("daemon-service.your-avatar-is-ready"),
      });
      ctx.live.publish({ type: 'invalidate', roomId, reason: 'message', agentId });
    }
    ctx.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message', agentId });
    return { id, createdAt: Math.floor(Date.now() / 1000) };
  }

  export async function daemonCommands(ctx: DaemonContext, input: Input<'postAgentCommands'>, agentId: string) {
    await ctx.database.query(
      `UPDATE agents SET commands=$2::jsonb,updated_at=now() WHERE agent_id=$1`,
      [agentId, JSON.stringify(input.commands)],
    );
    return daemonWriteResult(ctx);
  }

  export async function daemonModelCatalog(ctx: DaemonContext, input: Input<'postAgentModelCatalog'>, agentId: string) {
    return ctx.database.transaction(async (database) => {
    const prior = (await database.query<{
      model_unavailable: string | null; selected_model: string | null; owner_id: string; name: string; updated_at: Date;
      model_catalog: Input<'postAgentModelCatalog'>['options'];
    }>(
      `SELECT a.model_unavailable,a.selected_model,a.owner_id,i.name,a.updated_at,a.model_catalog FROM agents a
       JOIN identities i ON i.id=a.agent_id
       JOIN memberships agent_member ON agent_member.identity_id=a.agent_id
         AND agent_member.workspace_id=$2 AND agent_member.room_id IS NULL
         AND agent_member.removed_at IS NULL
       JOIN memberships owner_member ON owner_member.identity_id=a.owner_id
         AND owner_member.workspace_id=$2 AND owner_member.room_id IS NULL
         AND owner_member.removed_at IS NULL
       WHERE a.agent_id=$1`,
      [agentId, input.workspaceId],
    )).rows[0];
    await database.query(
      `UPDATE agents SET model_catalog=$2::jsonb,selected_model=COALESCE($3,selected_model),
         selected_effort=COALESCE($4,selected_effort),model_unavailable=$5,
         harness=COALESCE($7,harness),
         fast_mode=CASE WHEN $6 THEN fast_mode ELSE false END,updated_at=now()
       WHERE agent_id=$1`,
      [
        agentId,
        JSON.stringify(input.options),
        input.selection?.model ?? null,
        input.selection?.effort ?? null,
        input.unavailable ?? null,
        input.options.some(
          (axis) =>
            axis.id === 'fast-mode' &&
            axis.category === 'model_config' &&
            axis.options.some((choice) => choice.id === 'on') &&
            axis.options.some((choice) => choice.id === 'off'),
        ),
        input.harness ?? null,
      ],
    );
    // A model/effort choice the owner must replace is the only update-related
    // app notice. Routine release checks and successful probes stay silent.
    if (prior && !prior.model_unavailable &&
        (input.unavailable === 'model' || input.unavailable === 'effort')) {
      const roomId = await ensureSystemDirectMessageRoom(
        database, input.workspaceId, prior.owner_id,
      );
      await systemLine(database, {
        roomId,
        authorId: SYSTEM_IDENTITY_ID,
        id: createHash('sha256')
          .update(`agent-model-unavailable:v1:${agentId}:${input.unavailable}:${prior.updated_at.toISOString()}`)
          .digest('hex'),
        subject: { kind: 'agent', id: agentId, name: prior.name },
        verb: systemMessage("daemon-service.needs-a-different-model"),
        consequence: systemMessage("daemon-service.open-this-agent-s-settings-and-choose-an-available-model-or-effor"),
      });
    }
    // The daemon substitutes a same-family replacement automatically when a
    // persisted model id vanishes from the live catalog (`resolveModelFamilyFallback`
    // in `model-config.ts`, e.g. Claude dropping the `opus[1m]` alias) rather
    // than bricking the agent's turns. That is the only way this operation's
    // `selection.model` ever differs from the prior value (a human settings
    // change goes through a separate phone-only path), so this always names
    // a real automatic correction, never a routine catalog mirror.
    if (
      prior?.selected_model &&
      input.selection?.model &&
      input.selection.model !== prior.selected_model &&
      input.unavailable !== 'model' &&
      input.unavailable !== 'selection'
    ) {
      const roomId = await ensureSystemDirectMessageRoom(
        database, input.workspaceId, prior.owner_id,
      );
      // An alias (`default`) names the model it runs, never its menu text.
      const oldModelName =
        modelChoiceLabel(
          prior.model_catalog.find((axis) => axis.category === 'model'),
          prior.selected_model,
        ) ?? systemMessage("daemon-service.the-previous-model");
      const newModelName =
        modelChoiceLabel(
          input.options.find((axis) => axis.category === 'model'),
          input.selection.model,
        ) ?? systemMessage("daemon-service.the-default-model");
      await systemLine(database, {
        roomId,
        authorId: SYSTEM_IDENTITY_ID,
        id: createHash('sha256')
          .update(
            `agent-model-fallback:v1:${agentId}:${prior.selected_model}:${input.selection.model}:${prior.updated_at.toISOString()}`,
          )
          .digest('hex'),
        subject: { kind: 'agent', id: agentId, name: prior.name },
        verb: systemMessage("daemon-service.switched-models"),
        consequence: systemMessage("daemon-service.is-no-longer-offered-now-using", oldModelName, newModelName),
      });
    }
    return daemonWriteResult(ctx);
    });
  }

  export async function daemonMachineReport(ctx: DaemonContext, input: Input<'postAgentMachineReport'>, agentId: string) {
    await ctx.database.query(
      `UPDATE agents SET machine_id=$2,machine_name=$3,updated_at=now(),
         squire_work=CASE WHEN COALESCE(machine_id,agent_id)=$2 THEN squire_work ELSE '{}'::jsonb END
       WHERE agent_id=$1`,
      [agentId, input.machineId, input.machineName],
    );
    return ctx.writeResult();
  }
