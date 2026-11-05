import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { providerWebhookAssignments } from '../provider-webhooks.js';
import { settleFirstPartySignIn } from '../first-party-integrations.js';
import { queueSquireWork, squireAssignments, squireMachineId, squireWorkStatus, reportSquireWork } from '../squire-machine.js';
import { completeSquireMachineOffers, failConnectingOffers } from '../connector-offer-completion.js';
import { createHash } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { ensureSystemDirectMessageRoom, ensureSystemIdentity, systemLine } from '../system-line.js';
import { connectorAdapter } from '@beeline/api-contract/workbench';
import { applyVaultList, isMetadataStale, receiveConnectionUsage } from '../workbench.js';
import type { ConnectorAssignment, ConnectorStatus, ConnectorStep } from '@beeline/api-contract/workbench';
import { completeConnectorOffersForConnector } from '../connector-offer-completion.js';
import { notifyAgentConfigChange, notifyConnectorAssignment, notifyConnectorHelper } from '../postgres-live.js';
import type { DaemonContext } from './context.js';
import { Output, id, Input, registrySubject } from './values.js';



  // --- Workbench: connector helper operations --------------------------------

  /**
   * The helper's work queue for connectors it serves. Install/uninstall are
   * derived from the connector's own status (idempotent across polls); sync
   * is an edge-triggered token the read clears. Revoke-grants stays queued
   * until the helper confirms the provider drop.
   */
  export async function daemonConnectorAssignments(ctx: DaemonContext, agentId: string): Promise<Output<'getConnectorAssignments'>> {
    const connectors = (
      await ctx.database.query<{
        id: string;
        connector_type: string;
        status: string;
        pending_ops: string[];
        pairing_generation: number;
        registry_server_name: string | null;
        registry_version: string | null;
        registry_manifest: import('@beeline/api-contract/daemon').RegistryMcpManifest | null;
        force_relogin_provider: string | null;
      }>(
        `SELECT id,connector_type,status,pending_ops,pairing_generation,
                registry_server_name,registry_version,registry_manifest,force_relogin_provider
         FROM workspace_connectors
         WHERE helper_agent_id=$1 AND status IN ('installing','connected','error','disconnected')
         ORDER BY created_at`,
        [agentId],
      )
    ).rows;
    const assignments: ConnectorAssignment[] = await ctx.database.transaction(
      (db) => squireAssignments(db, agentId));
    for (const row of connectors) {
      const adapter = connectorAdapter(row.connector_type);
      const generation = { pairingGeneration: row.pairing_generation };
      if (adapter) {
        for (const kind of adapter.assignmentKinds(
          row.status as 'disconnected' | 'installing' | 'connected' | 'error',
        )) {
          if (kind !== 'install' && kind !== 'uninstall' && kind !== 'refresh-google-grant')
            continue;
          assignments.push(
            kind === 'refresh-google-grant'
              ? {
                  kind,
                  connectorId: row.id,
                  connectorType: row.connector_type as never,
                }
              : {
                  kind,
                  connectorId: row.id,
                  connectorType: row.connector_type as never,
                  ...generation,
                  ...(kind === 'install' && row.force_relogin_provider
                    ? { forceReloginProvider: row.force_relogin_provider }
                    : {}),
                },
          );
        }
      } else {
        if (row.status === 'installing')
          assignments.push({
            kind: 'install',
            connectorId: row.id,
            connectorType: row.connector_type as never,
            ...generation,
            ...(row.registry_server_name ? { registryServerName: row.registry_server_name } : {}),
            ...(row.registry_version ? { registryVersion: row.registry_version } : {}),
            ...(row.registry_manifest ? { registryManifest: row.registry_manifest } : {}),
            ...(row.force_relogin_provider
              ? { forceReloginProvider: row.force_relogin_provider }
              : {}),
          });
        if (row.status === 'disconnected')
          assignments.push({
            kind: 'uninstall',
            connectorId: row.id,
            connectorType: row.connector_type as never,
            ...generation,
          });
      }
      for (const op of row.pending_ops ?? []) {
        if (op === 'sync')
          assignments.push({
            kind: 'sync',
            connectorId: row.id,
            connectorType: row.connector_type as never,
          });
        else if (op.startsWith('revoke-grants:'))
          assignments.push({
            kind: 'revoke-grants',
            connectorId: row.id,
            connectorType: row.connector_type as never,
            reference: op.slice('revoke-grants:'.length),
          });
      }
    }
    const pendingIds = connectors
      .filter((row) => (row.pending_ops ?? []).length > 0)
      .map((row) => row.id);
    if (pendingIds.length)
      await ctx.database.query(
        `UPDATE workspace_connectors SET pending_ops = COALESCE((
           SELECT jsonb_agg(to_jsonb(elem))
           FROM jsonb_array_elements_text(pending_ops) AS elem
           WHERE elem LIKE 'revoke-grants:%'
         ), '[]'::jsonb)
         WHERE id = ANY($1::uuid[])`,
        [pendingIds],
      );
    assignments.push(...(await providerWebhookAssignments(ctx.database, agentId)).map((job) => ({
      kind: 'provider-webhook' as const, ...job,
    })));
    return { assignments };
  }


  /**
   * The helper reports it completed (or accepted) an install. `sign_in` is
   * written, not merged: the run that reaches `connected` printed no
   * ceremony, so whatever tunnel an earlier run published dies with it.
   */
  export async function daemonConnectorInstall(ctx: DaemonContext, 
    input: Input<'installConnector'>,
    agentId: string,
  ): Promise<Output<'installConnector'>> {
    if (squireMachineId(input.connectorId)) {
      await ctx.database.transaction(async (db) => {
        await reportSquireWork(db, agentId, { ...input, steps: [] }, true);
        const owner = (await db.query<{ owner_id: string; machine_id: string }>(
          'SELECT owner_id,COALESCE(machine_id,agent_id) machine_id FROM agents WHERE agent_id=$1', [agentId])).rows[0]!;
        await settleFirstPartySignIn(db, owner.owner_id, `machine:trusty-squire:${owner.machine_id}`);
        await notifyConnectorAssignment(db, agentId);
      });
      return { id: input.connectorId, createdAt: Math.floor(Date.now() / 1000) };
    }
    const result = await ctx.database.transaction(async (database) => {
      const row = (
        await database.query<{
          id: string;
          pairing_generation: number;
          connector_type: string;
          owner_identity_id: string;
          workspace_id: string;
          machine_id: string | null;
          helper_agent_id: string;
          install_agent_id: string | null;
          install_room_id: string | null;
          install_command_id: string | null;
          registry_server_name: string | null;
        }>(
          `SELECT id,pairing_generation,connector_type,owner_identity_id,workspace_id,machine_id,
                  helper_agent_id,install_agent_id,install_room_id,
                  install_command_id,registry_server_name
           FROM workspace_connectors
            WHERE id=$1::uuid AND helper_agent_id=$2 AND status='installing' FOR UPDATE`,
          [input.connectorId, agentId],
        )
      ).rows[0];
      if (!row) throw new Error('connector not found for this helper');
      if (
        input.pairingGeneration !== undefined &&
        input.pairingGeneration !== row.pairing_generation
      )
        throw new Error('connector not found for this helper');
      await database.query(
        `UPDATE workspace_connectors
         SET status='connected', status_steps='[]'::jsonb, status_error=NULL,
             squire_version=COALESCE($2,squire_version),
             signed_in_as=COALESCE($3,signed_in_as),
             sign_in=$4::jsonb, force_relogin_provider=NULL,
             connected_at=COALESCE(connected_at, now()), updated_at=now()
         WHERE id=$1::uuid`,
        [
          row.id,
          input.squireVersion ?? null,
          input.signedInAs ?? null,
          input.signIn ? JSON.stringify(input.signIn) : null,
        ],
      );
      let registryResume: { roomId: string; agentId: string } | undefined;
      const unifiedCard = row.connector_type === 'registry-mcp' && (await database.query(
        `SELECT 1 FROM messages WHERE card_type='app-sign-in'
          AND card->>'connectKind'='registry-mcp' AND card->>'connectorId'=$1 LIMIT 1`, [row.id])).rowCount > 0;
      if (row.connector_type === 'tailscale')
        await settleFirstPartySignIn(database, row.owner_identity_id,
          `machine:tailscale:${row.machine_id ?? row.helper_agent_id}`);
      if (row.connector_type === 'registry-mcp') {
        const app = (await database.query<{ app_key: string }>(
          'SELECT app_key FROM workspace_apps WHERE connector_id=$1', [row.id])).rows[0];
        if (app) await settleFirstPartySignIn(database, row.owner_identity_id, app.app_key);
      }
      if (
        row.connector_type === 'registry-mcp' && !unifiedCard &&
        row.install_agent_id &&
        row.install_room_id &&
        row.install_command_id
      ) {
        // A resume-kind line completes its parent command. OAuth can finish
        // while that command is still writing its own reply, so only resume
        // an already-ended install turn. Lock the command with the connector
        // row to serialize this decision against the reply's completion.
        const command = (
          await database.query<{ state: string }>(
            `SELECT state FROM agent_commands
             WHERE id=$1 AND room_id=$2 AND agent_id=$3 FOR UPDATE`,
            [row.install_command_id, row.install_room_id, row.install_agent_id],
          )
        ).rows[0];
        if (command?.state === 'complete') {
          await ensureSystemIdentity(database);
          await systemLine(database, {
            id: createHash('sha256')
              .update(`registry-mcp-connected:${row.id}:${row.pairing_generation}`)
              .digest('hex'),
            roomId: row.install_room_id,
            authorId: SYSTEM_IDENTITY_ID,
            subject: { kind: 'system', name: registrySubject(row.registry_server_name) },
            verb: systemMessage("daemon-service.connected"),
            consequence: systemMessage("daemon-service.the-requesting-agent-can-continue-the-original-task"),
            kind: 'connector-offer-decided',
            commandId: row.install_command_id,
            wakes: [row.install_agent_id],
          });
          registryResume = { roomId: row.install_room_id, agentId: row.install_agent_id };
        }
      }
      return {
        row,
        completedOffers: await completeConnectorOffersForConnector(database, row.id),
        registryResume,
      };
    });
    for (const offer of result.completedOffers) {
      ctx.live.publish({
        type: 'invalidate',
        roomId: offer.roomId,
        reason: 'connector-offer',
        agentId: offer.agentId,
      });
    }
    if (result.registryResume) {
      ctx.live.publish({
        type: 'invalidate',
        roomId: result.registryResume.roomId,
        reason: 'connector-ready',
        agentId: result.registryResume.agentId,
      });
    }
    if (result.row.connector_type === 'registry-mcp') {
      const agents = await ctx.database.query<{ agent_id: string }>(
        `SELECT actor.agent_id FROM agents actor
         JOIN memberships member ON member.identity_id=actor.agent_id
           AND member.workspace_id=$1 AND member.room_id IS NULL AND member.removed_at IS NULL
         WHERE actor.owner_id=$2
           AND COALESCE(actor.machine_id,actor.agent_id)=COALESCE($3,$4)`,
        [
          result.row.workspace_id,
          result.row.owner_identity_id,
          result.row.machine_id,
          result.row.helper_agent_id,
        ],
      );
      for (const actor of agents.rows)
        await notifyAgentConfigChange(ctx.database, actor.agent_id, result.row.workspace_id);
    }
    return { id: result.row.id, createdAt: Math.floor(Date.now() / 1000) };
  }


  /**
   * One incremental install report from the helper: the ordered steps as they
   * settle, plus the sign-in surface and installed version it learned. A
   * report carrying `errorMessage` marks the run failed; otherwise the row
   * stays installing until `installConnector` completes it.
   *
   * Status, helper, and pairing generation are revalidated in the UPDATE so a
   * disconnect or re-pair that lands between a stale helper's read and write
   * cannot overwrite the newer lifecycle. An omitted generation is generation
   * 1: a pre-generation helper can still report against the first pairing and
   * cannot match a later one.
   */
  export async function daemonConnectorStatusReport(ctx: DaemonContext, 
    input: Input<'postConnectorStatus'>,
    agentId: string,
  ): Promise<Output<'postConnectorStatus'>> {
    if (squireMachineId(input.connectorId)) {
      await ctx.database.transaction((db) => reportSquireWork(db, agentId, input));
      return { id: input.connectorId, createdAt: Math.floor(Date.now() / 1000) };
    }
    const row = await ctx.database.transaction(async db => {
      const row = (
        await db.query<{
          id: string;
          connector_type: string;
          registry_server_name: string | null;
        }>(
          `UPDATE workspace_connectors
           SET status=CASE WHEN $3::text IS NOT NULL THEN 'error' ELSE status END,
               status_error=COALESCE($3::text,status_error),
               status_steps=$2::jsonb,
               squire_version=COALESCE($4,squire_version),
               signed_in_as=COALESCE($5,signed_in_as),
               sign_in=CASE WHEN $7::boolean THEN $6::jsonb ELSE sign_in END,
               updated_at=now()
           WHERE id=$1::uuid
             AND helper_agent_id=$8
             AND status='installing'
             AND pairing_generation=$9
           RETURNING id,connector_type,registry_server_name`,
          [
            input.connectorId,
            JSON.stringify(input.steps),
            input.errorMessage ?? null,
            input.squireVersion ?? null,
            input.signedInAs ?? null,
            input.signIn ? JSON.stringify(input.signIn) : null,
            input.signIn !== undefined,
            agentId,
            input.pairingGeneration ?? 1,
          ],
        )
      ).rows[0];
      if (!row) throw new Error('connector not found for this helper');
      if (input.errorMessage) await failConnectingOffers(db, { agentId, connectorId: row.id });
      return row;
    });
    if (input.signIn?.url) await daemonNotifyTailscaleSignIn(ctx, row.id, input.signIn.url, agentId);
    if (row.connector_type === 'registry-mcp' && input.signIn?.url && input.signIn.attemptId)
      await daemonResumeRegistrySignIn(ctx, row, input.signIn);
    return { id: row.id, createdAt: Math.floor(Date.now() / 1000) };
  }


  /**
   * A Registry sign-in page the helper just published is ONE fact: the first
   * needs_sign_in per attempt posts a resume-kind line into the install Room,
   * whose command resume wakes the turn that called connect_mcp_server — but
   * only once that turn has ENDED. A still-claimed install command means the
   * agent is mid-turn and will read the needs_sign_in result itself, so
   * writing the line would complete its command out from under it. The
   * helper's 2s watch re-posts the same attempt after the turn ends, and that
   * later report is the one that resumes. The same attempt never resumes
   * twice — the line id is derived from the attempt, so repeat reports
   * collide and write nothing.
   */
  export async function daemonResumeRegistrySignIn(ctx: DaemonContext, 
    row: { id: string; registry_server_name: string | null },
    signIn: NonNullable<Input<'postConnectorStatus'>['signIn']>,
  ): Promise<void> {
    if (signIn.method !== 'oauth') return;
    const unifiedCard = await ctx.database.query(`SELECT 1 FROM messages WHERE card_type='app-sign-in'
      AND card->>'connectKind'='registry-mcp' AND card->>'connectorId'=$1 AND card->>'status'='pending' LIMIT 1`, [row.id]);
    if (unifiedCard.rowCount) return;
    const target = (
      await ctx.database.query<{
        install_room_id: string;
        install_agent_id: string;
        install_command_id: string;
        command_state: string | null;
      }>(
        `SELECT c.install_room_id,c.install_agent_id,c.install_command_id,command.state command_state
         FROM workspace_connectors c
         LEFT JOIN agent_commands command ON command.id=c.install_command_id
         WHERE c.id=$1::uuid AND c.install_room_id IS NOT NULL
           AND c.install_agent_id IS NOT NULL AND c.install_command_id IS NOT NULL`,
        [row.id],
      )
    ).rows[0];
    if (!target) return;
    if (
      target.command_state === null ||
      target.command_state === 'pending' ||
      target.command_state === 'claimed' ||
      target.command_state === 'cancelled'
    )
      return;
    await ensureSystemIdentity(ctx.database);
    const wrote = await systemLine(ctx.database, {
      id: createHash('sha256')
        .update(`registry-mcp-signin-resume:${row.id}:${signIn.attemptId}`)
        .digest('hex'),
      roomId: target.install_room_id,
      authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'system', name: registrySubject(row.registry_server_name) },
      verb: systemMessage("daemon-service.needs"),
      object: { text: systemMessage("daemon-service.provider-sign-in"), url: signIn.url },
      consequence: systemMessage("daemon-service.the-provider-sign-in-page-is-ready-connect-this-tool-through-trus"),
      kind: 'connector-offer-decided',
      commandId: target.install_command_id,
      wakes: [target.install_agent_id],
    });
    if (wrote.inserted)
      ctx.live.publish({
        type: 'invalidate',
        roomId: target.install_room_id,
        reason: 'connector-ready',
        agentId: target.install_agent_id,
      });
  }


  /**
   * A Tailscale login URL is posted to the helper owner's @System DM so
   * they can click it. Workbench still holds the same signIn; this is the
   * owner-visible half when the node needs sign-in instead of failing.
   */
  export async function daemonNotifyTailscaleSignIn(ctx: DaemonContext, 
    connectorId: string,
    url: string,
    agentId: string,
  ): Promise<void> {
    if (!/^https:\/\/login\.tailscale\.com\//u.test(url)) return;
    const row = (
      await ctx.database.query<{
        workspace_id: string;
        connector_type: string;
        owner_id: string;
        helper_name: string;
      }>(
        `SELECT k.workspace_id,k.connector_type,a.owner_id,agent.name helper_name
         FROM workspace_connectors k
         JOIN agents a ON a.agent_id=k.helper_agent_id
         JOIN identities agent ON agent.id=a.agent_id
         WHERE k.id=$1::uuid AND k.helper_agent_id=$2`,
        [connectorId, agentId],
      )
    ).rows[0];
    if (!row || row.connector_type !== 'tailscale') return;
    const roomId = await ensureSystemDirectMessageRoom(ctx.database, row.workspace_id, row.owner_id);
    await systemLine(ctx.database, {
      roomId,
      authorId: SYSTEM_IDENTITY_ID,
      id: createHash('sha256').update(`tailscale-signin:${connectorId}:${url}`).digest('hex'),
      subject: { kind: 'agent', id: agentId, name: row.helper_name },
      verb: systemMessage("daemon-service.needs"),
      object: { text: systemMessage("daemon-service.tailscale-sign-in"), url },
      consequence: systemMessage("daemon-service.click-the-link-to-join-this-machine-to-the-tailnet"),
    });
  }


  /**
   * The broker verdict and vault metadata from this helper's own machine.
   * A failed probe preserves cached keys; successful metadata stays scoped
   * to the machine owner. Squire has no persisted connector row.
   */
  export async function daemonConnectorVaultReport(ctx: DaemonContext, 
    input: Input<'postConnectorVault'>,
    agentId: string,
  ): Promise<Output<'postConnectorVault'>> {
    const completed = await ctx.database.transaction(async (db) => {
      const machine = (await db.query<{ owner_id: string; machine_id: string; workspace_id: string }>(
        `SELECT a.owner_id,COALESCE(a.machine_id,a.agent_id) machine_id,m.workspace_id
         FROM agents a JOIN memberships m ON m.identity_id=a.agent_id
           AND m.room_id IS NULL AND m.removed_at IS NULL
         WHERE a.agent_id=$1 ORDER BY m.joined_at LIMIT 1`, [agentId],
      )).rows[0];
      if (!machine) throw new Error('machine helper not found');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',
        [`squire-vault:${machine.owner_id}:${machine.machine_id}`]);
      // An owner unpair survives startup/reconnect broker reports. Explicit pairing
      // clears this machine decision; the local Squire account stays in its vault.
      const disconnected = await db.query(`SELECT 1 FROM agents WHERE owner_id=$1
        AND COALESCE(machine_id,agent_id)=$2 AND squire_work->>'disconnected'='true'`,
        [machine.owner_id, machine.machine_id]);
      if (disconnected.rowCount) return [];
      const report = { status: input.notAdded ? 'not-added' : input.errorMessage ? 'error' : 'connected',
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        reportedAt: Date.now() / 1000 };
      await db.query('UPDATE agents SET squire_report=$2::jsonb WHERE agent_id=$1',
        [agentId, JSON.stringify(report)]);
      if (input.errorMessage || input.notAdded) return [];
      await applyVaultList(db, { owner_identity_id: machine.owner_id,
        machine_id: machine.machine_id, workspace_id: machine.workspace_id }, input.connections);
      return completeSquireMachineOffers(db, machine.owner_id, machine.machine_id);
    });
    for (const offer of completed) ctx.live.publish({ type: 'invalidate', roomId: offer.roomId,
      reason: 'connector-offer', agentId: offer.agentId });
    return { id: agentId, createdAt: Math.floor(Date.now() / 1000) };
  }


  /**
   * The helper polls one connector's state; stale metadata stages a sync.
   * `connectorId` names WHICH row — a helper carrying the four Google rows
   * beside its Squire row would otherwise read whichever came first.
   */
  export async function daemonConnectorStatusView(ctx: DaemonContext, 
    agentId: string,
    connectorId?: string,
  ): Promise<Output<'getConnectorStatus'>> {
    if (connectorId && squireMachineId(connectorId)) {
      const status = await squireWorkStatus(ctx.database, agentId);
      if (status.connectorId !== connectorId) throw new Error('Squire machine access denied');
      return status;
    }
    const rows = (
      await ctx.database.query<{
        id: string;
        status: string;
        status_steps: ConnectorStep[] | null;
        status_error: string | null;
      }>(
        `SELECT id,status,status_steps,status_error FROM workspace_connectors
         WHERE helper_agent_id=$1
         ORDER BY created_at`,
        [agentId],
      )
    ).rows;
    // Reap unpaired rows the uninstall assignment has had time to reach: the
    // helper's status poll after the drain is the uninstall ack path.
    for (const row of rows) {
      if (row.status !== 'disconnected') continue;
      const empty = await ctx.database.query(
        `SELECT 1 FROM workspace_connections WHERE connector_id=$1::uuid LIMIT 1`,
        [row.id],
      );
      if (!empty.rowCount)
        await ctx.database.query(`DELETE FROM workspace_connectors WHERE id=$1::uuid`, [row.id]);
    }
    const live = (
      await ctx.database.query<{
        id: string;
        status: string;
        status_steps: ConnectorStep[] | null;
        status_error: string | null;
        sign_in: ConnectorStatus['signIn'] | null;
      }>(
        `SELECT id,status,status_steps,status_error,sign_in FROM workspace_connectors
         WHERE helper_agent_id=$1 AND status IN ('installing','connected','error')
           AND ($2::uuid IS NULL OR id=$2::uuid)
         ORDER BY created_at LIMIT 1`,
        [agentId, connectorId ?? null],
      )
    ).rows[0];
    if (!live) return { connectorId: '', status: 'disconnected', steps: [] };
    return {
      connectorId: live.id,
      status: live.status as ConnectorStatus['status'],
      steps: live.status_steps ?? [],
      ...(live.sign_in ? { signIn: live.sign_in } : {}),
      ...(live.status_error ? { errorMessage: live.status_error } : {}),
    };
  }


  /** The cached vault metadata for the helper's connections; stale rows stage a sync. */
  export async function daemonConnectorVaultList(ctx: DaemonContext, agentId: string): Promise<Output<'getConnectorVaultList'>> {
    const rows = (
      await ctx.database.query<{
        id: string;
        connector_id: string;
        reference: string;
        service: string | null;
        label: string | null;
        hosts: string[];
        state: string;
        connection_metadata: { fieldNames?: string[]; vaultCreatedAt?: number } | null;
        last_synced_at: Date | null;
      }>(
        `SELECT c.id,COALESCE(c.connector_id::text,'squire:' || c.machine_id) connector_id,c.reference,c.service,c.label,c.hosts,c.state,
                c.connection_metadata,c.last_synced_at
         FROM workspace_connections c
         JOIN agents a ON a.agent_id=$1
         LEFT JOIN workspace_connectors k ON k.id=c.connector_id
         WHERE (k.helper_agent_id=$1 OR (c.owner_identity_id=a.owner_id
           AND c.machine_id=COALESCE(a.machine_id,a.agent_id)))
         ORDER BY c.created_at`,
        [agentId],
      )
    ).rows;
    const staleConnectorIds = new Set<string>();
    const connections = rows.map((row) => {
      if (isMetadataStale(row.last_synced_at)) staleConnectorIds.add(row.connector_id);
      return {
        reference: row.reference,
        service: row.service,
        label: row.label ?? row.reference,
        fieldNames: row.connection_metadata?.fieldNames ?? [],
        allowedHosts: row.hosts ?? [],
        createdAt: row.connection_metadata?.vaultCreatedAt ?? Math.floor(Date.now() / 1000),
        stale: isMetadataStale(row.last_synced_at),
        state: row.state === 'error' ? ('error' as const) : ('active' as const),
      };
    });
    for (const connectorId of staleConnectorIds) {
      if (squireMachineId(connectorId)) {
        await ctx.database.transaction((db) => queueSquireWork(db, agentId, { op: 'sync' }));
        continue;
      }
      await ctx.database.query(
        `UPDATE workspace_connectors
         SET pending_ops = pending_ops || '"sync"'::jsonb, updated_at=now()
         WHERE id=$1::uuid AND NOT pending_ops @> '"sync"'::jsonb`,
        [connectorId],
      );
      await notifyConnectorHelper(ctx.database, connectorId);
    }
    return { connections };
  }


  /** Cached detail for one connection the helper serves. */
  export async function daemonConnectionDetail(ctx: DaemonContext, 
    input: Input<'getConnectionDetail'>,
    agentId: string,
  ): Promise<Output<'getConnectionDetail'>> {
    const row = (
      await ctx.database.query<{
        id: string;
        connector_id: string;
        reference: string;
        service: string | null;
        label: string | null;
        hosts: string[];
        state: string;
        grants: Array<Record<string, unknown>> | null;
        connection_metadata: { fieldNames?: string[]; vaultCreatedAt?: number } | null;
        last_synced_at: Date | null;
      }>(
        `SELECT c.id,COALESCE(c.connector_id::text,'squire:' || c.machine_id) connector_id,c.reference,c.service,c.label,c.hosts,c.state,
                c.grants,c.connection_metadata,c.last_synced_at
         FROM workspace_connections c
         JOIN agents a ON a.agent_id=$1
         LEFT JOIN workspace_connectors k ON k.id=c.connector_id
         WHERE (k.helper_agent_id=$1 OR (c.owner_identity_id=a.owner_id
           AND c.machine_id=COALESCE(a.machine_id,a.agent_id))) AND c.reference=$2`,
        [agentId, input.ref],
      )
    ).rows[0];
    if (!row) throw new Error(`unknown connection reference ${input.ref}`);
    if (isMetadataStale(row.last_synced_at)) {
      if (squireMachineId(row.connector_id)) {
        await ctx.database.transaction((db) => queueSquireWork(db, agentId, { op: 'sync' }));
      } else {
        await ctx.database.query(
          `UPDATE workspace_connectors
           SET pending_ops = pending_ops || '"sync"'::jsonb, updated_at=now()
           WHERE id=$1::uuid AND NOT pending_ops @> '"sync"'::jsonb`,
          [row.connector_id],
        );
        await notifyConnectorHelper(ctx.database, row.connector_id);
      }
    }
    const ledger = (
      await ctx.database.query<{
        id: string;
        operation: string;
        status_code: number | null;
        bytes: string;
        grant_info: string | null;
        created_at: Date;
      }>(
        `SELECT id,operation,status_code,bytes,grant_info,created_at
         FROM connection_receipts WHERE connection_id=$1::uuid
         ORDER BY created_at DESC LIMIT 50`,
        [row.id],
      )
    ).rows;
    return {
      metadata: {
        reference: row.reference,
        service: row.service,
        label: row.label ?? row.reference,
        fieldNames: row.connection_metadata?.fieldNames ?? [],
        allowedHosts: row.hosts ?? [],
        createdAt: row.connection_metadata?.vaultCreatedAt ?? Math.floor(Date.now() / 1000),
        stale: isMetadataStale(row.last_synced_at),
        state: row.state === 'error' ? 'error' : 'active',
      },
      grants: (row.grants ?? []) as unknown as Output<'getConnectionDetail'>['grants'],
      ledger: ledger.map((entry) => ({
        id: entry.id,
        timestamp: Math.floor(entry.created_at.getTime() / 1000),
        action: entry.operation,
        ...(entry.status_code !== null ? { status: entry.status_code } : {}),
        ...(Number(entry.bytes) > 0 ? { bytes: Number(entry.bytes) } : {}),
        ...(entry.grant_info ? { actor: entry.grant_info } : {}),
      })),
    };
  }


  /** Helper confirmation that the provider dropped the grants. */
  export async function daemonConnectionGrantRevoke(ctx: DaemonContext, 
    input: Input<'revokeConnectionGrants'>,
    agentId: string,
  ): Promise<Output<'revokeConnectionGrants'>> {
    const row = (
      await ctx.database.query<{
        id: string;
        connector_id: string;
        reference: string;
        grants: Array<Record<string, unknown>> | null;
      }>(
        `SELECT c.id,COALESCE(c.connector_id::text,'squire:' || c.machine_id) connector_id,c.reference,c.grants
         FROM workspace_connections c
         JOIN agents a ON a.agent_id=$1
         LEFT JOIN workspace_connectors k ON k.id=c.connector_id
         WHERE (k.helper_agent_id=$1 OR (c.owner_identity_id=a.owner_id
           AND c.machine_id=COALESCE(a.machine_id,a.agent_id))) AND c.reference=$2`,
        [agentId, input.ref],
      )
    ).rows[0];
    if (!row) throw new Error(`unknown connection reference ${input.ref}`);
    const live = (row.grants ?? []).filter((grant) => !grant.revokedAt);
    const revokedAt = Math.floor(Date.now() / 1000);
    const updated = (row.grants ?? []).map((grant) => {
      if (grant.revokedAt) return grant;
      const next: Record<string, unknown> = { ...grant, revokedAt };
      delete next.revokingAt;
      return next;
    });
    await ctx.database.query(
      `UPDATE workspace_connections SET grants=$2::jsonb, updated_at=now() WHERE id=$1::uuid`,
      [row.id, JSON.stringify(updated)],
    );
    if (squireMachineId(row.connector_id)) {
      await ctx.database.query(`UPDATE agents SET squire_work=jsonb_set(squire_work,'{ops}',
        COALESCE((SELECT jsonb_agg(to_jsonb(op)) FROM jsonb_array_elements_text(
          COALESCE(squire_work->'ops','[]'::jsonb)) op WHERE op<>$2),'[]'::jsonb))
        WHERE (owner_id,COALESCE(machine_id,agent_id))=(
          SELECT owner_id,COALESCE(machine_id,agent_id) FROM agents WHERE agent_id=$1)`,
        [agentId, `revoke-grants:${row.reference}`]);
    } else {
    await ctx.database.query(
      `UPDATE workspace_connectors SET pending_ops = COALESCE((
         SELECT jsonb_agg(to_jsonb(elem))
         FROM jsonb_array_elements_text(pending_ops) AS elem
         WHERE elem <> $2
       ), '[]'::jsonb), updated_at=now()
       WHERE id=$1::uuid`,
      [row.connector_id, `revoke-grants:${row.reference}`],
    );
    }
    return { revoked: live.length, failed: 0 };
  }


  export async function daemonConnectionUsage(ctx: DaemonContext, 
    input: Input<'postConnectionUsage'>,
    agentId: string,
  ): Promise<Output<'postConnectionUsage'>> {
    await receiveConnectionUsage(ctx.database, input, agentId);
    return { id: input.requestId, createdAt: Math.floor(Date.now() / 1000) };
  }
