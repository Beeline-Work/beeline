import { type QueryResultRow } from 'pg';
import { AuthStore, MIGRATIONS, OidcFlow, SqlExecutor, FlowRow, flowFromRow, IdentityLink, asDate, AgentConnectDevice, AgentConnectDeviceRow, agentConnectDeviceFromRow, BindTicket, TicketRow, ticketFromRow, PhoneTicketExchangeResult, BindResult, RecoverBindResult } from './store.js';



  /**
   * Resolve the relay's authoritative tenant stamp for a Room.
   *
   * The similarly named `community` tag on kind:9007 is client-authored
   * application metadata. Buzz stamps `channels.community_id` from the
   * request Host and treats that SQL column as the tenancy boundary.
   */
  export async function authStoreRelayCommunityIdForRoom(ctx: AuthStore, roomId: string): Promise<string | null> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)
    ) {
      return null;
    }
    const result = await ctx.database.query<QueryResultRow & { community_id: string }>(
      `SELECT community_id::text AS community_id
       FROM channels
       WHERE id = $1::uuid AND deleted_at IS NULL
       LIMIT 1`,
      [roomId],
    );
    return result.rows[0]?.community_id ?? null;
  }


  export async function authStoreMigrate(ctx: AuthStore): Promise<void> {
    for (const migration of MIGRATIONS) await ctx.database.query(migration);
    await ctx.database.query(`CREATE OR REPLACE FUNCTION beeline_auth_ticket_completion() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('beeline_command_completion',json_build_object(
          'principal','auth','operation','ticket','commandId',NEW.ticket_hash)::text);
        RETURN NULL;
      END; $$ LANGUAGE plpgsql`);
    await ctx.database.query('DROP TRIGGER IF EXISTS beeline_auth_ticket_completion ON beeline_bind_tickets');
    await ctx.database.query(`CREATE TRIGGER beeline_auth_ticket_completion AFTER INSERT OR UPDATE ON beeline_bind_tickets
      FOR EACH ROW EXECUTE FUNCTION beeline_auth_ticket_completion()`);
  }


  export async function authStoreCreateFlow(ctx: AuthStore, stateHash: string, flow: OidcFlow): Promise<void> {
    await ctx.database.query(`DELETE FROM beeline_oidc_flows WHERE expires_at < $1`, [
      flow.createdAt,
    ]);
    await ctx.insertFlow(ctx.database, stateHash, flow, null);
  }


  /**
   * Replace a consumed flow with a continuation flow. The native recovery hash
   * moves to the new row in one transaction, so exactly one row holds it.
   */
  export async function authStoreContinueFlow(ctx: AuthStore, previousStateHash: string, stateHash: string, flow: OidcFlow): Promise<void> {
    await ctx.database.transaction(async (transaction) => {
      let nativeCancelledAt: unknown = null;
      if (flow.appRecoveryHash) {
        const previous = await transaction.query<QueryResultRow & { native_cancelled_at: unknown }>(
          `UPDATE beeline_oidc_flows SET app_recovery_hash = NULL
           WHERE state_hash = $1 AND app_recovery_hash = $2
           RETURNING native_cancelled_at`,
          [previousStateHash, flow.appRecoveryHash],
        );
        nativeCancelledAt = previous.rows[0]?.native_cancelled_at ?? null;
      }
      await ctx.insertFlow(transaction, stateHash, flow, nativeCancelledAt);
    });
  }


  export async function authStoreInsertFlow(ctx: AuthStore,
    executor: SqlExecutor,
    stateHash: string,
    flow: OidcFlow,
    nativeCancelledAt: unknown,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO beeline_oidc_flows
        (state_hash, community, issuer, audience, nonce, pkce_verifier, browser_session_hash, redirect_uri, app_redirect_uri, app_state, device_code_hash, app_recovery_hash, created_at, expires_at, native_cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        stateHash,
        flow.community,
        flow.issuer,
        flow.audience,
        flow.nonce,
        flow.pkceVerifier,
        flow.browserSessionHash,
        flow.redirectUri,
        flow.appRedirectUri,
        flow.appState,
        flow.deviceCodeHash ?? null,
        flow.appRecoveryHash ?? null,
        flow.createdAt,
        flow.expiresAt,
        nativeCancelledAt,
      ],
    );
  }


  export async function authStoreConsumeFlow(ctx: AuthStore,
    stateHash: string,
    browserSessionHash: string,
    now: Date,
  ): Promise<OidcFlow | null> {
    const result = await ctx.database.query<FlowRow>(
      `UPDATE beeline_oidc_flows
       SET consumed_at = $3
       WHERE state_hash = $1 AND browser_session_hash = $2 AND consumed_at IS NULL
         AND native_cancelled_at IS NULL AND expires_at >= $3
       RETURNING community, issuer, audience, nonce, pkce_verifier, browser_session_hash, redirect_uri, app_redirect_uri, app_state, device_code_hash, app_recovery_hash, created_at, expires_at`,
      [stateHash, browserSessionHash, now],
    );
    return result.rows[0] ? { ...flowFromRow(result.rows[0]), stateHash } : null;
  }


  export async function authStoreIdentityLinkForSubject(ctx: AuthStore,
    community: string,
    issuer: string,
    audience: string,
    subject: string,
  ): Promise<IdentityLink | null> {
    const result = await ctx.database.query<
      QueryResultRow & {
        community: string;
        issuer: string;
        audience: string;
        subject: string;
        pubkey: string;
        created_at: unknown;
      }
    >(
      `SELECT community, issuer, audience, subject, pubkey, created_at
       FROM beeline_identity_links
       WHERE community = $1 AND issuer = $2 AND audience = $3 AND subject = $4
       LIMIT 1`,
      [community, issuer, audience, subject],
    );
    const row = result.rows[0];
    return row
      ? {
          community: row.community,
          issuer: row.issuer,
          audience: row.audience,
          subject: row.subject,
          pubkey: row.pubkey,
          createdAt: asDate(row.created_at),
        }
      : null;
  }


  export async function authStoreLatestWorkspaceForMember(ctx: AuthStore,
    memberPubkey: string,
    relayCommunityIds: readonly string[],
  ): Promise<{ workspaceId: string; name: string } | null> {
    if (!/^[0-9a-f]{64}$/.test(memberPubkey) || relayCommunityIds.length === 0) return null;
    const result = await ctx.database.query<
      QueryResultRow & { workspace_id: string; name: string }
    >(
      `SELECT workspace.id::text AS workspace_id, workspace.name
       FROM channels workspace
       JOIN channel_members member
         ON member.community_id = workspace.community_id
        AND member.channel_id = workspace.id
        AND member.pubkey = decode($1, 'hex')
        AND member.removed_at IS NULL
       JOIN LATERAL (
         SELECT event.tags FROM events event
         WHERE event.community_id = workspace.community_id
           AND event.channel_id = workspace.id
           AND event.kind = 9007
           AND event.deleted_at IS NULL
         ORDER BY event.created_at ASC, event.id ASC LIMIT 1
       ) genesis ON EXISTS (
         SELECT 1 FROM jsonb_array_elements(genesis.tags) tag
         WHERE tag->>0 = 'community' AND tag->>1 = workspace.id::text
       )
       WHERE workspace.community_id = ANY($2::uuid[])
         AND workspace.deleted_at IS NULL
         AND workspace.archived_at IS NULL
       ORDER BY workspace.updated_at DESC, workspace.id ASC
       LIMIT 1`,
      [memberPubkey, relayCommunityIds],
    );
    const row = result.rows[0];
    return row ? { workspaceId: row.workspace_id, name: row.name } : null;
  }


  export async function authStoreCreateAgentConnectDevice(ctx: AuthStore, device: AgentConnectDevice): Promise<void> {
    await ctx.database.query(`DELETE FROM beeline_agent_connect_devices WHERE expires_at < $1`, [
      device.createdAt,
    ]);
    await ctx.database.query(
      `INSERT INTO beeline_agent_connect_devices (
         device_code_hash, user_code, code_challenge, tenant_community,
         harness, provider, model, soul, agent_name, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        device.deviceCodeHash,
        device.userCode,
        device.codeChallenge,
        device.tenantCommunity,
        device.harness,
        device.provider ?? null,
        device.model,
        device.soul,
        device.agentName,
        device.createdAt,
        device.expiresAt,
      ],
    );
  }


  export async function authStoreFindAgentConnectDeviceByUserCode(ctx: AuthStore, userCode: string): Promise<AgentConnectDevice | null> {
    const result = await ctx.database.query<AgentConnectDeviceRow>(
      `SELECT device_code_hash, user_code, code_challenge, tenant_community,
              harness, provider, model, soul, agent_name, sealed_credentials,
              pairing_token_hash, workspace_id, paired_by, agent_pubkey,
              created_at, expires_at, approved_at, consumed_at
       FROM beeline_agent_connect_devices WHERE user_code = $1`,
      [userCode],
    );
    return result.rows[0] ? agentConnectDeviceFromRow(result.rows[0]) : null;
  }


  export async function authStoreFindAgentConnectDevice(ctx: AuthStore, deviceCodeHash: string): Promise<AgentConnectDevice | null> {
    const result = await ctx.database.query<AgentConnectDeviceRow>(
      `SELECT device_code_hash, user_code, code_challenge, tenant_community,
              harness, provider, model, soul, agent_name, sealed_credentials,
              pairing_token_hash, workspace_id, paired_by, agent_pubkey,
              created_at, expires_at, approved_at, consumed_at
       FROM beeline_agent_connect_devices WHERE device_code_hash = $1`,
      [deviceCodeHash],
    );
    return result.rows[0] ? agentConnectDeviceFromRow(result.rows[0]) : null;
  }


  export async function authStoreApproveAgentConnectDevice(ctx: AuthStore, input: {
    deviceCodeHash: string;
    workspaceId: string;
    pairedBy: string;
    agentPubkey: string;
    pairingTokenHash: string;
    sealedCredentials: string;
    now: Date;
  }): Promise<boolean> {
    return ctx.database.transaction(async (transaction) => {
      const approved = await transaction.query<QueryResultRow>(
        `UPDATE beeline_agent_connect_devices
         SET workspace_id = $2::uuid,
             paired_by = decode($3, 'hex'),
             agent_pubkey = decode($4, 'hex'),
             pairing_token_hash = $5,
             sealed_credentials = $6,
             approved_at = $7
         WHERE device_code_hash = $1
           AND approved_at IS NULL
           AND consumed_at IS NULL
           AND expires_at >= $7
         RETURNING device_code_hash`,
        [
          input.deviceCodeHash,
          input.workspaceId,
          input.pairedBy,
          input.agentPubkey,
          input.pairingTokenHash,
          input.sealedCredentials,
          input.now,
        ],
      );
      if (approved.rowCount !== 1) return false;
      const grant = await transaction.query<QueryResultRow>(
        `INSERT INTO beeline_agent_connect_grants (
           token_hash, community_id, workspace_id, minter_pubkey, agent_pubkey,
           expires_at, created_at
         )
         SELECT pairing_token_hash, workspace.community_id, workspace_id,
                paired_by, agent_pubkey, expires_at, $2
         FROM beeline_agent_connect_devices device
         JOIN channels workspace ON workspace.id = device.workspace_id
         WHERE device.device_code_hash = $1
         RETURNING token_hash`,
        [input.deviceCodeHash, input.now],
      );
      if (grant.rowCount !== 1) throw new Error('device approval did not create a pairing grant');
      return true;
    });
  }


  export async function authStoreConsumeAgentConnectDevice(ctx: AuthStore,
    deviceCodeHash: string,
    now: Date,
  ): Promise<AgentConnectDevice | null> {
    const result = await ctx.database.query<AgentConnectDeviceRow>(
      `UPDATE beeline_agent_connect_devices
       SET consumed_at = $2
       WHERE device_code_hash = $1
         AND approved_at IS NOT NULL
         AND consumed_at IS NULL
         AND expires_at >= $2
       RETURNING device_code_hash, user_code, code_challenge, tenant_community,
                 harness, provider, model, soul, agent_name, sealed_credentials,
                 pairing_token_hash, workspace_id, paired_by, agent_pubkey,
                 created_at, expires_at, approved_at, consumed_at`,
      [deviceCodeHash, now],
    );
    return result.rows[0] ? agentConnectDeviceFromRow(result.rows[0]) : null;
  }


  export async function authStoreCreateTicket(ctx: AuthStore, ticketHash: string, ticket: BindTicket): Promise<void> {
    await ctx.database.query(`DELETE FROM beeline_bind_tickets WHERE expires_at < $1`, [
      ticket.createdAt,
    ]);
    await ctx.database.query(
      `INSERT INTO beeline_bind_tickets
        (ticket_hash, challenge, community, issuer, audience, subject, created_at, expires_at,
         provider_login, provider_display_name, provider_avatar)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        ticketHash,
        ticket.challenge,
        ticket.community,
        ticket.issuer,
        ticket.audience,
        ticket.subject,
        ticket.createdAt,
        ticket.expiresAt,
        ticket.providerLogin ?? null,
        ticket.providerDisplayName ?? null,
        ticket.providerAvatar ?? null,
      ],
    );
  }


  /** Finalize a native recovery transaction only while its initiating app still owns it. */
  export async function authStoreCreateRecoveryTicket(ctx: AuthStore,
    recoveryHash: string,
    ticket: BindTicket,
    now: Date,
  ): Promise<boolean> {
    return ctx.database.transaction(async (transaction) => {
      const flow = await transaction.query<QueryResultRow>(
        `SELECT state_hash FROM beeline_oidc_flows
         WHERE app_recovery_hash = $1 AND consumed_at IS NOT NULL
           AND native_cancelled_at IS NULL AND expires_at >= $2
         FOR UPDATE`,
        [recoveryHash, now],
      );
      if (flow.rowCount !== 1) return false;
      const inserted = await transaction.query<QueryResultRow>(
        `INSERT INTO beeline_bind_tickets
          (ticket_hash, challenge, community, issuer, audience, subject, created_at, expires_at,
           provider_login, provider_display_name, provider_avatar)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (ticket_hash) DO NOTHING
         RETURNING ticket_hash`,
        [
          recoveryHash,
          ticket.challenge,
          ticket.community,
          ticket.issuer,
          ticket.audience,
          ticket.subject,
          ticket.createdAt,
          ticket.expiresAt,
          ticket.providerLogin ?? null,
          ticket.providerDisplayName ?? null,
          ticket.providerAvatar ?? null,
        ],
      );
      return inserted.rowCount === 1;
    });
  }


  /** Cancel pending or completed recovery without revealing whether the token existed. */
  export async function authStoreCancelRecoveryTicket(ctx: AuthStore, recoveryHash: string, now: Date): Promise<void> {
    await ctx.database.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE beeline_oidc_flows SET native_cancelled_at = COALESCE(native_cancelled_at, $2)
         WHERE app_recovery_hash = $1 AND expires_at >= $2`,
        [recoveryHash, now],
      );
      await transaction.query(
        `UPDATE beeline_bind_tickets SET consumed_at = COALESCE(consumed_at, $2)
         WHERE ticket_hash = $1 AND expires_at >= $2`,
        [recoveryHash, now],
      );
    });
  }


  export async function authStoreFindTicket(ctx: AuthStore, ticketHash: string): Promise<BindTicket | null> {
    const result = await ctx.database.query<TicketRow>(
      `SELECT challenge, community, issuer, audience, subject, created_at, expires_at, attempt_count, consumed_at, bound_pubkey, recovery_eligible, provider_login, provider_display_name, provider_avatar
       FROM beeline_bind_tickets WHERE ticket_hash = $1`,
      [ticketHash],
    );
    return result.rows[0] ? ticketFromRow(result.rows[0]) : null;
  }


  export async function authStoreRecordFailedTicketAttempt(ctx: AuthStore, ticketHash: string, now: Date): Promise<number | null> {
    const result = await ctx.database.query<QueryResultRow & { attempt_count: number }>(
      `UPDATE beeline_bind_tickets
       SET attempt_count = attempt_count + 1,
           consumed_at = CASE WHEN attempt_count + 1 >= 5 THEN $2 ELSE consumed_at END
       WHERE ticket_hash = $1 AND consumed_at IS NULL AND expires_at >= $2 AND attempt_count < 5
       RETURNING attempt_count`,
      [ticketHash, now],
    );
    return result.rows[0]?.attempt_count ?? null;
  }


  /** Atomically consume the same short-lived GitHub proof used by the legacy key bind. */
  export async function authStoreConsumeTicketForPhone(ctx: AuthStore,
    ticketHash: string,
    community: string,
    now: Date,
    issuer = 'https://github.com',
  ): Promise<PhoneTicketExchangeResult> {
    return ctx.database.transaction(async (transaction) => {
      const selected = await transaction.query<TicketRow>(
        `SELECT challenge, community, issuer, audience, subject, created_at, expires_at,
                attempt_count, consumed_at, bound_pubkey, recovery_eligible,
                provider_login, provider_display_name, provider_avatar
         FROM beeline_bind_tickets WHERE ticket_hash = $1 FOR UPDATE`,
        [ticketHash],
      );
      const row = selected.rows[0];
      if (!row) return { status: 'missing' };
      const ticket = ticketFromRow(row);
      if (ticket.consumedAt) return { status: 'used' };
      if (ticket.expiresAt.getTime() < now.getTime()) return { status: 'expired' };
      if (ticket.community !== community || ticket.issuer !== issuer) {
        return { status: 'wrong_provider' };
      }
      await transaction.query(
        `UPDATE beeline_bind_tickets SET consumed_at = $2 WHERE ticket_hash = $1`,
        [ticketHash, now],
      );
      return { status: 'exchanged', ticket };
    });
  }


  export async function authStoreConsumeTicketAndLink(ctx: AuthStore, ticketHash: string, pubkey: string, now: Date): Promise<BindResult> {
    return ctx.database.transaction(async (transaction) => {
      const selected = await transaction.query<TicketRow>(
        `SELECT challenge, community, issuer, audience, subject, created_at, expires_at, attempt_count, consumed_at, bound_pubkey, recovery_eligible, provider_login, provider_display_name, provider_avatar
         FROM beeline_bind_tickets WHERE ticket_hash = $1 FOR UPDATE`,
        [ticketHash],
      );
      const row = selected.rows[0];
      if (!row) return { status: 'missing' };
      const ticket = ticketFromRow(row);
      if (ticket.consumedAt) return { status: 'used' };
      if (ticket.expiresAt.getTime() < now.getTime()) return { status: 'expired' };

      await transaction.query(
        `UPDATE beeline_bind_tickets SET consumed_at = $2, bound_pubkey = $3 WHERE ticket_hash = $1`,
        [ticketHash, now, pubkey],
      );
      const inserted = await transaction.query<QueryResultRow>(
        `INSERT INTO beeline_identity_links
          (community, issuer, audience, subject, pubkey, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (community, issuer, audience, subject) DO NOTHING
         RETURNING community`,
        [ticket.community, ticket.issuer, ticket.audience, ticket.subject, pubkey, now],
      );
      const linked = await transaction.query<
        QueryResultRow & {
          community: string;
          issuer: string;
          audience: string;
          subject: string;
          pubkey: string;
          created_at: unknown;
        }
      >(
        `SELECT community, issuer, audience, subject, pubkey, created_at
         FROM beeline_identity_links
         WHERE community = $1 AND issuer = $2 AND audience = $3 AND subject = $4`,
        [ticket.community, ticket.issuer, ticket.audience, ticket.subject],
      );
      const linkRow = linked.rows[0];
      if (!linkRow) throw new Error('identity link transaction produced no mapping');
      if (linkRow.pubkey !== pubkey) {
        await transaction.query(
          `UPDATE beeline_bind_tickets SET recovery_eligible = TRUE WHERE ticket_hash = $1`,
          [ticketHash],
        );
        return { status: 'conflict', existingPubkey: linkRow.pubkey };
      }
      return {
        status: inserted.rowCount === 1 ? 'linked' : 'idempotent',
        link: {
          community: linkRow.community,
          issuer: linkRow.issuer,
          audience: linkRow.audience,
          subject: linkRow.subject,
          pubkey: linkRow.pubkey,
          createdAt: asDate(linkRow.created_at),
        },
      };
    });
  }


  /**
   * Replace a conflicting link only after the normal bind path has consumed
   * this exact OAuth-backed ticket for this exact candidate key.
   */
  export async function authStoreRecoverConsumedTicketLink(ctx: AuthStore,
    ticketHash: string,
    pubkey: string,
    now: Date,
  ): Promise<RecoverBindResult> {
    return ctx.database.transaction(async (transaction) => {
      const selected = await transaction.query<TicketRow>(
        `SELECT challenge, community, issuer, audience, subject, created_at, expires_at, attempt_count, consumed_at, bound_pubkey, recovery_eligible, provider_login, provider_display_name, provider_avatar
         FROM beeline_bind_tickets WHERE ticket_hash = $1 FOR UPDATE`,
        [ticketHash],
      );
      const row = selected.rows[0];
      if (!row) return { status: 'missing' };
      const ticket = ticketFromRow(row);
      if (ticket.expiresAt.getTime() < now.getTime()) return { status: 'expired' };
      if (!ticket.consumedAt) return { status: 'unused' };
      if (!row.recovery_eligible) return { status: 'not_eligible' };
      if (ticket.boundPubkey !== pubkey) return { status: 'wrong_key' };

      const linked = await transaction.query<
        QueryResultRow & {
          community: string;
          issuer: string;
          audience: string;
          subject: string;
          pubkey: string;
          created_at: unknown;
        }
      >(
        `SELECT community, issuer, audience, subject, pubkey, created_at
         FROM beeline_identity_links
         WHERE community = $1 AND issuer = $2 AND audience = $3 AND subject = $4
         FOR UPDATE`,
        [ticket.community, ticket.issuer, ticket.audience, ticket.subject],
      );
      const existing = linked.rows[0];
      if (!existing) return { status: 'missing' };
      const previousPubkey = existing.pubkey;
      if (previousPubkey !== pubkey) {
        await transaction.query(
          `UPDATE beeline_identity_links
           SET pubkey = $5, created_at = $6
           WHERE community = $1 AND issuer = $2 AND audience = $3 AND subject = $4`,
          [ticket.community, ticket.issuer, ticket.audience, ticket.subject, pubkey, now],
        );
        // Succession ledger: the old key authored rooms/bindings/approvals as
        // this identity, and chain-aware authority must keep honoring it
        // THROUGH the new key. Recorded in the same transaction as the link
        // update so the ledger can never disagree with the link. Replacing
        // from the same old key twice is idempotent (upsert keeps the latest
        // successor).
        await transaction.query(
          `INSERT INTO beeline_key_successions
            (community, issuer, audience, subject, old_pubkey, new_pubkey, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (community, issuer, audience, subject, old_pubkey)
           DO UPDATE SET new_pubkey = EXCLUDED.new_pubkey, created_at = EXCLUDED.created_at`,
          [
            ticket.community,
            ticket.issuer,
            ticket.audience,
            ticket.subject,
            previousPubkey,
            pubkey,
            now,
          ],
        );
      }
      return {
        status: previousPubkey === pubkey ? 'idempotent' : 'replaced',
        previousPubkey,
        link: {
          community: existing.community,
          issuer: existing.issuer,
          audience: existing.audience,
          subject: existing.subject,
          pubkey,
          createdAt: previousPubkey === pubkey ? asDate(existing.created_at) : now,
        },
      };
    });
  }


  export async function authStoreClaimNip98Event(ctx: AuthStore, eventId: string, expiresAt: Date, now: Date): Promise<boolean> {
    return ctx.database.transaction(async (transaction) => {
      await transaction.query(`DELETE FROM beeline_nip98_replays WHERE expires_at < $1`, [now]);
      const result = await transaction.query<QueryResultRow>(
        `INSERT INTO beeline_nip98_replays (event_id, expires_at)
         VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [eventId, expiresAt],
      );
      return result.rowCount === 1;
    });
  }
