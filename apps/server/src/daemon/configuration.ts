import { cornerOwnerSql } from '../corner-worker.js';
import { cornerReviewerSql } from '../corner-reviewer.js';
import { FREE_AGENT_APP_CONNECT_GUIDE, FREE_AGENT_REPOSITORY_GUIDE, FREE_AGENT_TURN_GUIDE } from '../free-agents.js';
import { isAgentReachable } from '@beeline/api-contract/agent-access';
import { isCornerReviewer } from '../agent-health.js';
import type { DaemonContext } from './context.js';
import { daemonAccess } from './access.js';
import { id, registryMcpRouteName, Input } from './values.js';
import { daemonRepositoryOnboardingRequester } from './grants.js';


  export async function daemonIdentitySuccession(ctx: DaemonContext, identityId: string) {
    const rows = await ctx.database.query<{ old_identity_id: string; new_identity_id: string }>(
      `SELECT old_identity_id,new_identity_id FROM identity_successions`,
    );
    const next = new Map(rows.rows.map((row) => [row.old_identity_id, row.new_identity_id]));
    let current = identityId;
    const predecessors: string[] = [];
    const seen = new Set<string>();
    while (next.has(current) && !seen.has(current)) {
      seen.add(current);
      predecessors.push(current);
      current = next.get(current)!;
    }
    return { currentIdentityId: current, predecessors };
  }

  export async function daemonConfiguration(ctx: DaemonContext, agentId: string, roomId?: string, context?: Record<string, unknown>) {
    if (roomId) await daemonAccess(ctx, roomId, agentId);
    const row = (
      await ctx.database.query<{
        soul: { name: string; instructions: string } | null;
        selected_model: string | null;
        selected_effort: string | null;
        fast_mode: boolean;
        commands: Array<{ name: string; description?: string; inputHint?: string }>;
        yolo_mode: boolean;
        reviewer_handle: string | null;
      }>(
        `SELECT a.soul,a.selected_model,a.selected_effort,a.fast_mode,a.commands,
                CASE WHEN workspace.visibility='public' THEN false ELSE a.yolo_mode END yolo_mode,
                CASE WHEN room.parent_id IS NULL THEN NULL
                     WHEN reviewer.id<>COALESCE(${cornerOwnerSql('room.id')},room.created_by)
                     THEN reviewer.handle END reviewer_handle
         FROM agents a
         JOIN identities self ON self.id=a.agent_id
         LEFT JOIN rooms room ON room.id=$2
         LEFT JOIN workspaces workspace ON workspace.id=room.workspace_id
         LEFT JOIN rooms parent ON parent.id=room.parent_id
         LEFT JOIN corner_facts fact ON fact.corner_id=room.id
         LEFT JOIN identities reviewer
           ON reviewer.id=${cornerReviewerSql('room')} AND reviewer.kind='agent'
         WHERE a.agent_id=$1`,
        [agentId, roomId],
      )
    ).rows[0];
    const registryMcpRoutes = roomId
      ? (
          await ctx.database.query<{
            id: string;
            registry_server_name: string;
            display_name: string | null;
          }>(
            `SELECT connector.id,connector.registry_server_name,connector.display_name
             FROM workspace_connectors connector
             -- A connected app is the PERSON's (their Workbench spans
             -- Workspaces), so its server mounts wherever that owner's agent
             -- runs on the machine that holds it; every call is still
             -- authorized per Room and requester as app:<key>.
             JOIN rooms room ON room.id=$2
             JOIN agents actor ON actor.agent_id=$1
               AND actor.owner_id=connector.owner_identity_id
               AND COALESCE(actor.machine_id,actor.agent_id)=COALESCE(connector.machine_id,connector.helper_agent_id)
             WHERE connector.connector_type='registry-mcp' AND connector.status='connected'
             ORDER BY connector.created_at,connector.id`,
            [agentId, roomId],
          )
        ).rows.map((route) => ({
          connectorId: route.id,
          serverName: route.registry_server_name,
          displayName: route.display_name ?? route.registry_server_name,
          routeName: registryMcpRouteName(route.registry_server_name, route.id),
          target: `registry-mcp:${route.registry_server_name}`,
        }))
      : [];
    if (row?.soul) {
      const freeAgent = (await ctx.database.query(
        `SELECT 1 FROM free_agents WHERE agent_id=$1`, [agentId],
      )).rowCount > 0;
      const owner = freeAgent ? await daemonRepositoryOnboardingRequester(ctx, agentId, roomId, context) : undefined;
      if (freeAgent && !row.soul.instructions.includes(FREE_AGENT_TURN_GUIDE))
        row.soul = { ...row.soul, instructions: `${row.soul.instructions}\n\n${FREE_AGENT_TURN_GUIDE}` };
      if (freeAgent && !row.soul.instructions.includes(FREE_AGENT_APP_CONNECT_GUIDE))
        row.soul = { ...row.soul, instructions: `${row.soul.instructions}\n\n${FREE_AGENT_APP_CONNECT_GUIDE}` };
      if (owner)
        row.soul = { ...row.soul, instructions: `${row.soul.instructions}\n\n${FREE_AGENT_REPOSITORY_GUIDE}` };
    }
    const isReviewer =
      Boolean(roomId) && (await isCornerReviewer(ctx.database, roomId!, agentId));
    return {
      ...(row?.soul ? { soul: { name: row.soul.name, instructions: row.soul.instructions } } : {}),
      ...(row?.selected_model ? { model: row.selected_model } : {}),
      ...(row?.selected_effort ? { effort: row.selected_effort } : {}),
      fastMode: row?.fast_mode ?? false,
      commands: row?.commands ?? [],
      yoloMode: row?.yolo_mode ?? false,
      isReviewer,
      ...(row?.reviewer_handle ? { reviewerHandle: row.reviewer_handle } : {}),
      ...(registryMcpRoutes.length ? { registryMcpRoutes } : {}),
    };
  }

  export async function daemonPresence(ctx: DaemonContext, input: Input<'getAgentPresence'>, agentId: string) {
    const row = (
      await ctx.database.query<{
        body: {
          status: 'online' | 'offline';
          observedAt: number;
          releaseVersion?: string;
          sourceSha?: string;
          held?: unknown;
        };
        updated_at: Date;
      }>(
        `SELECT body,updated_at FROM live_outputs WHERE agent_id=$1 AND kind='presence' ORDER BY updated_at DESC LIMIT 1`,
        [agentId],
      )
    ).rows[0];
    return row
      ? {
          status: isAgentReachable(
            row.body.status, row.updated_at.getTime(), Date.now(), row.body.held === true,
          )
            ? 'online'
            : 'offline',
          observedAt: Math.max(row.body.observedAt, Math.floor(row.updated_at.getTime() / 1_000)),
          ...(row.body.releaseVersion ? { releaseVersion: row.body.releaseVersion } : {}),
          ...(row.body.sourceSha ? { sourceSha: row.body.sourceSha } : {}),
        }
      : { status: 'dormant' as const };
  }


  /** Public, secret-free release gate over active agent registrations. */
  export async function daemonReleaseReadiness(ctx: DaemonContext) {
    const result = await ctx.database.query<{
      agent_id: string;
      updated_at: Date | null;
      body: {
        status?: string;
        observedAt?: number;
        releaseVersion?: string;
        sourceSha?: string;
        held?: unknown;
      } | null;
    }>(
      `SELECT a.agent_id,lo.body,lo.updated_at
       FROM agents a
       LEFT JOIN LATERAL(
         SELECT body,updated_at FROM live_outputs
         WHERE agent_id=a.agent_id AND kind='presence'
         ORDER BY updated_at DESC LIMIT 1
       )lo ON true
       WHERE EXISTS(
         SELECT 1 FROM memberships m
         WHERE m.identity_id=a.agent_id AND m.room_id IS NULL AND m.removed_at IS NULL
       )
       ORDER BY a.agent_id`,
    );
    const daemons = result.rows.map((row) => {
      const body = row.body;
      const observedAt = body?.observedAt;
      const state = !body
        ? 'never-seen'
        : !isAgentReachable(
            body.status === 'online' ? 'online' : 'offline',
            row.updated_at?.getTime(),
            Date.now(),
            body.held === true,
          )
          ? 'offline'
          : 'ready';
      return {
        agentPubkey: row.agent_id,
        state,
        ...(typeof observedAt === 'number' ? { observedAt } : {}),
        ...(row.body?.releaseVersion ? { version: row.body.releaseVersion } : {}),
        ...(row.body?.sourceSha ? { sha: row.body.sourceSha } : {}),
      };
    });
    const summary = { total: 0, ready: 0, neverSeen: 0 };
    for (const daemon of daemons) {
      summary.total += 1;
      if (daemon.state === 'ready') summary.ready += 1;
      if (daemon.state === 'never-seen') summary.neverSeen += 1;
    }
    return { daemons, summary };
  }
