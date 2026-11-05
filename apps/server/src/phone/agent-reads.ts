import { cornerOwnerSql } from '../corner-worker.js';
import { mcpClientName } from '../rooms-mcp-logos.js';
import { agentUsageColumns, projectAgentUsage, type AgentUsageRow } from '../agent-usage.js';
import { isAgentSignInHarness } from '@beeline/api-contract/phone';
import type { AgentGrantView, AgentDetailView, WorkspaceMemberGrantView } from '@beeline/api-contract/phone';
import { FACE_SOULS, resolveFace } from '@beeline/api-contract/phone';
import { isCommandGrantScript } from '@beeline/api-contract/agent-grants';
import { parseAgentAccessPolicy } from '@beeline/api-contract/agent-access';
import type { PhoneContext } from './context.js';
import { MemberRow, AgentGrantRow, McpClientIdentity, mcpClientIdentitySql } from './types.js';
import { PROFILE_GRANT_LIMIT, unix, MemberGrantRow } from './values.js';
import { phoneOptionalEnrichment } from './optional-enrichment.js';
import { phoneProjectMembers } from './roster.js';
import { identity, reviveDates } from './read-projection.js';



  export async function phoneReadAgent(ctx: PhoneContext, 
    workspaceId: string,
    agentId: string,
    viewerId: string,
    workCursor?: string,
  ): Promise<AgentDetailView | null> {
    let cursor: [string, string] | null = null;
    if (workCursor) {
      try {
        const value: unknown = JSON.parse(workCursor);
        if (!Array.isArray(value) || value.length !== 2 ||
          !value.every((part) => typeof part === 'string' && part.length <= 2048))
          throw new Error('invalid cursor');
        cursor = value as [string, string];
      } catch {
        throw new Error('invalid recent work cursor');
      }
    }
    const core = await ctx.database.query<{
      member_id: string; member_name: string; member_handle: string | null;
      member_avatar: string | null; member_face: string | null;
      member_role: MemberRow['role'];
      config_version: string | null;
      soul: AgentDetailView['soul'] | null;
      model_catalog: AgentDetailView['catalog'] | null;
      commands: AgentDetailView['commands'] | null;
      selected_model: string | null; selected_effort: string | null;
      fast_mode: boolean | null; model_unavailable: 'model' | 'effort' | 'selection' | null;
      yolo_mode: boolean; yolo_forced_off: boolean; yolo_set_by_name: string | null;
      yolo_set_at: Date | null; avatar_generation_id: string | null;
      avatar_generation_pending: boolean; can_change_yolo: boolean;
      can_manage_grants: boolean; harness: string | null; access_policy: unknown;
      owner_id: string | null; owner_name: string | null; owner_handle: string | null;
      recent_work: Array<{ title: string; url: string; merged_at: string }>;
      grants: AgentGrantRow[];
      mcp_client: McpClientIdentity | null;
    } & AgentUsageRow>(`SELECT agent_identity.id member_id,
        ${mcpClientIdentitySql('a.agent_id')} mcp_client,agent_identity.name member_name,
        agent_identity.handle member_handle,agent_identity.avatar member_avatar,
        agent_identity.face_id member_face,agent_membership.role member_role,
        a.harness,a.soul,a.model_catalog,a.commands,a.selected_model,a.selected_effort,
        a.fast_mode,a.model_unavailable,
        floor(extract(epoch FROM a.updated_at)*1000000)::bigint::text config_version,
        (SELECT id::text FROM agent_avatars WHERE agent_id=a.agent_id) avatar_generation_id,
        EXISTS(SELECT 1 FROM agent_commands c WHERE c.agent_id=a.agent_id
          AND c.avatar_job AND c.state IN ('pending','claimed')) avatar_generation_pending,
        CASE WHEN workspace.visibility='public' THEN false ELSE COALESCE(a.yolo_mode,false) END yolo_mode,
        workspace.visibility='public' yolo_forced_off,a.yolo_set_at,
        setter.name yolo_set_by_name,a.access_policy,a.owner_id,
        owner.name owner_name,owner.handle owner_handle,
        a.owner_id=$3 can_change_yolo,
        ${agentUsageColumns('a', '$3')},
        (a.owner_id=$3 OR viewer_membership.role IN ('owner','admin')) can_manage_grants,
        COALESCE((SELECT jsonb_agg(to_jsonb(work)) FROM (
          SELECT max(f.lifecycle->'pr'->>'title') title,
            f.lifecycle->'pr'->>'url' url,max(f.lifecycle->'pr'->>'mergedAt') merged_at
          FROM corner_github_cache f JOIN rooms r ON r.id=f.corner_id
          WHERE r.workspace_id=$2 AND ${cornerOwnerSql('r.id')}=$1
            AND NULLIF(f.lifecycle->'pr'->>'mergedAt','') IS NOT NULL
            AND NULLIF(f.lifecycle->'pr'->>'title','') IS NOT NULL
            AND f.lifecycle->'pr'->>'url' ~ '^https://github[.]com/[^/]+/[^/]+/pull/[0-9]+$'
            AND EXISTS (SELECT 1 FROM memberships m WHERE m.room_id=r.id
              AND m.identity_id=$3 AND m.removed_at IS NULL)
          GROUP BY f.lifecycle->'pr'->>'url'
          HAVING $4::text IS NULL OR (max(f.lifecycle->'pr'->>'mergedAt'),
            f.lifecycle->'pr'->>'url') < ($4,$5)
          ORDER BY merged_at DESC,url DESC LIMIT 6
        ) work),'[]'::jsonb) recent_work,
        COALESCE((SELECT jsonb_agg(to_jsonb(grant_row)) FROM (
          SELECT g.id,g.kind,g.target,g.reason,g.status,g.room_id,g.auto,
            g.created_at,g.decided_at,g.expires_at,g.script,
            to_jsonb(requester) requester,to_jsonb(decider) decider
          FROM agent_grants g
          JOIN identities requester ON requester.id=g.requested_by
          LEFT JOIN identities decider ON decider.id=g.decided_by
          WHERE g.agent_id=$1 AND g.workspace_id=$2 AND g.status<>'pending'
            AND (g.kind IN ('repository','shared_asset') OR a.owner_id=$3)
          ORDER BY g.created_at DESC,g.id LIMIT $6
        ) grant_row),'[]'::jsonb) grants
      FROM memberships agent_membership
      JOIN identities agent_identity ON agent_identity.id=agent_membership.identity_id
        AND agent_identity.kind='agent' AND agent_identity.hidden_from_roster=false
      JOIN memberships viewer_membership ON viewer_membership.workspace_id=$2
        AND viewer_membership.room_id IS NULL AND viewer_membership.identity_id=$3
        AND viewer_membership.removed_at IS NULL
      JOIN workspaces workspace ON workspace.id=agent_membership.workspace_id
      LEFT JOIN agents a ON a.agent_id=agent_membership.identity_id
      LEFT JOIN identities setter ON setter.id=a.yolo_set_by
      LEFT JOIN identities owner ON owner.id=a.owner_id
      WHERE agent_membership.identity_id=$1 AND agent_membership.workspace_id=$2
        AND agent_membership.room_id IS NULL AND agent_membership.removed_at IS NULL`,
      [agentId, workspaceId, viewerId, cursor?.[0] ?? null,cursor?.[1] ?? null,
        PROFILE_GRANT_LIMIT],
    );
    const config = core.rows[0];
    if (!config) return null;
    const presence = (await phoneOptionalEnrichment(ctx, 'member-presence',
      ctx.enrichmentDatabase.query<{
        presence_body: MemberRow['presence_body']; presence_updated_at: Date | null;
      }>(`SELECT live.body presence_body,live.updated_at presence_updated_at
        FROM live_outputs live WHERE live.agent_id=$1 AND live.kind='presence'
        ORDER BY live.updated_at DESC LIMIT 1`, [agentId])));
    const presenceRow = presence?.rows[0];
    // An AI-client member's instructions live in its own app, so its profile
    // names that app instead of a made-up animal soul.
    const mcpClient = config.mcp_client
      ? mcpClientName(config.mcp_client.name, config.mcp_client.redirects) : undefined;
    const wake = mcpClient && config.owner_id === viewerId
      ? (await ctx.database.query<{ url: string | null; keySet: boolean }>(
        `SELECT NULLIF(COALESCE(member.callback_url,client.callback_url),'') url,
          member.callback_secret IS NOT NULL "keySet"
         FROM rooms_mcp_members member JOIN rooms_mcp_clients client ON client.id=member.client_id
         WHERE member.member_id=$1`, [agentId])).rows[0]
      : undefined;
    const member = phoneProjectMembers(ctx, [{
      id: config.member_id,kind: 'agent',name: config.member_name,
      handle: config.member_handle,avatar: config.member_avatar,
      face_id: config.member_face,role: config.member_role,
      presence_body: presenceRow?.presence_body ?? null,
      presence_updated_at: presenceRow?.presence_updated_at ?? null,
    }], null)[0]!;
    const recentWork = config.recent_work;
    const grants = phoneProjectAgentGrants(ctx, config.grants);
    const workPage = recentWork.slice(0, 5);
    const lastWork = workPage.at(-1);
    return {
      workspaceId,
      ...(wake ? { wake } : {}),
      ...(config?.harness ? { harness: config.harness } : {}),
      ...(config?.owner_id === viewerId ? { usage: projectAgentUsage(config) } : {}),
      ...(config?.config_version ? { configVersion: config.config_version } : {}),
      ...(config?.avatar_generation_id ? { avatarGenerationId: config.avatar_generation_id } : {}),
      avatarGenerationPending: config?.avatar_generation_pending ?? false,
      recentWork: workPage.map(({ title, url }) => ({ title, url })),
      ...(recentWork.length > 5 && lastWork
        ? { recentWorkCursor: JSON.stringify([lastWork.merged_at, lastWork.url]) }
        : {}),
      agent: member,
      ...(config?.soul
        ? {
            soul: {
              ...config.soul,
              // Souls stored before the avatar-seed rule (e.g. connect-wizard
              // souls) default the seed to the agent pubkey, matching display.
              avatarSeed: config.soul.avatarSeed || agentId,
            },
          }
        : {}),
      // The soul this agent's animal carries: what an edited soul restores to.
      // Derived from the face it wears, so name, avatar and soul stay one animal.
      seededSoul: mcpClient
        ? `Connected through ${mcpClient}. Its instructions live in ${mcpClient}, not in Beeline.`
        : FACE_SOULS[resolveFace(member.identity.face, agentId)],
      ...(config?.owner_id && config.owner_name
        ? {
            owner: {
              pubkey: config.owner_id,
              kind: 'human' as const,
              name: config.owner_name,
              ...(config.owner_handle ? { handle: config.owner_handle } : {}),
            },
          }
        : {}),
      catalog: config?.model_catalog ?? [],
      fastMode: Boolean(
        config?.fast_mode &&
        (!config.selected_model ||
          config.model_catalog?.find((axis) => axis.category === 'model')?.currentValue ===
            config.selected_model) &&
        config.model_catalog?.some(
          (axis) =>
            axis.id === 'fast-mode' &&
            axis.category === 'model_config' &&
            axis.options.some((choice) => choice.id === 'on') &&
            axis.options.some((choice) => choice.id === 'off'),
        ),
      ),
      commands: config?.commands ?? [],
      ...(config?.model_unavailable ? { modelUnavailable: config.model_unavailable } : {}),
      ...(mcpClient || config?.selected_model || config?.selected_effort
        ? {
            selected: {
              ...(mcpClient || config.selected_model ? { model: mcpClient ?? config.selected_model! } : {}),
              ...(config.selected_effort ? { effort: config.selected_effort } : {}),
            },
          }
        : {}),
      yolo: {
        enabled: config?.yolo_mode ?? false,
        ...(config?.yolo_forced_off ? { forcedOff: true } : {}),
        ...(config?.yolo_set_by_name ? { setBy: { name: config.yolo_set_by_name } } : {}),
        ...(config?.yolo_set_at ? { setAt: unix(config.yolo_set_at) } : {}),
        canChange: config?.can_change_yolo ?? false,
      },
      // Who may address this agent. Read from the server row, never from what a
      // helper was paired with, so the row and the running behaviour are one fact.
      access: {
        policy: parseAgentAccessPolicy(config?.access_policy).type,
        ...(config?.owner_id && config.owner_name
          ? {
              owner: {
                id: config.owner_id,
                name: config.owner_name,
                ...(config.owner_handle ? { handle: config.owner_handle } : {}),
              },
            }
          : {}),
        canChange: config?.can_change_yolo ?? false,
      },
      grants,
      // Grant decisions retain their separate owner-or-Workspace-manager axis.
      canManageGrants: config?.can_manage_grants ?? false,
      canLogin: config?.owner_id === viewerId && isAgentSignInHarness(config?.harness),
      watchFilters: [],
    };
  }

  /** Project the bounded ledger returned with the authorized profile core. */
  export function phoneProjectAgentGrants(ctx: PhoneContext, rows: AgentGrantRow[]): AgentGrantView[] {
    for (const row of rows) reviveDates(row, ['created_at','decided_at','expires_at']);
    return rows.map((row) => ({
      grantId: row.id,
      kind: row.kind,
      target: row.target,
      reason: row.reason,
      status: row.status,
      requestedBy: identity(row.requester, ctx.publicOrigin),
      ...(row.decider ? { decidedBy: identity(row.decider, ctx.publicOrigin) } : {}),
      roomId: row.room_id,
      createdAt: unix(row.created_at),
      ...(row.decided_at ? { decidedAt: unix(row.decided_at) } : {}),
      ...(row.expires_at ? { expiresAt: unix(row.expires_at) } : {}),
      auto: row.auto,
      // C94: the profile shows what the interpreter approval was bound to.
      ...(isCommandGrantScript(row.script) ? { script: row.script } : {}),
    }));
  }


  /** Grant rows already selected with the member profile's authorized core. */
  export function phoneProjectMemberGrantRows(ctx: PhoneContext, rows: readonly MemberGrantRow[]): WorkspaceMemberGrantView[] {
    return rows.map((row) => ({
      grantId: row.id,
      kind: row.kind,
      target: row.target,
      reason: row.reason,
      status: row.status,
      requestedBy: identity(row.requester, ctx.publicOrigin),
      ...(row.decider ? { decidedBy: identity(row.decider, ctx.publicOrigin) } : {}),
      roomId: row.room_id,
      ...(row.room_name !== null ? { roomName: row.room_name } : {}),
      createdAt: unix(row.created_at),
      ...(row.decided_at ? { decidedAt: unix(row.decided_at) } : {}),
      ...(row.expires_at ? { expiresAt: unix(row.expires_at) } : {}),
      auto: row.auto,
      ...(isCommandGrantScript(row.script) ? { script: row.script } : {}),
      agent: identity(row.agent, ctx.publicOrigin),
    }));
  }
