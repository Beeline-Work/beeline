import { createHash, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { GitHubOperations } from './github-operations.js';
import { GoogleOAuth } from './google-oauth.js';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import {
  applyVaultList,
  connectorIdentityId,
  ensureConnectorDirectMessageRoom,
} from './workbench.js';

const HUMAN = createHash('sha256').update('github:owner').digest('hex');
const RECIPIENT = createHash('sha256').update('github:recipient').digest('hex');
const HELPER = 'b'.repeat(64);
const OTHER_HELPER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

describe('workbench connectors', () => {
  let database: PgliteDatabase;
  let auth: TokenAuth;
  let origin: string;
  let server: ReturnType<typeof createBeelineServer>;
  let accessToken: string;
  let recipientToken: string;
  let helperToken: string;
  let otherHelperToken: string;
  let phone: PhoneService;
  let daemon: DaemonService;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await new AuthStore(database as unknown as TransactionalDatabase).migrate();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject)
       VALUES($1,'human','Owner','owner','owner'),($2,'agent','Bee','bee',NULL),
             ($3,'human','Recipient','recipient','recipient'),($4,'agent','Wasp','wasp',NULL)`,
      [HUMAN, HELPER, RECIPIENT, OTHER_HELPER],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2),($3,$4)`, [
      HELPER,
      HUMAN,
      OTHER_HELPER,
      RECIPIENT,
    ]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),($1,NULL,$5,'member')`,
      [WORKSPACE, HUMAN, RECIPIENT, HELPER, OTHER_HELPER],
    );
    auth = new TokenAuth(database, async (proof) => {
      const login = proof === 'proof' ? 'owner' : proof === 'recipient-proof' ? 'recipient' : proof;
      return { subject: login, login, name: login[0]!.toUpperCase() + login.slice(1) };
    });
    const githubOperations = new GitHubOperations(
      database,
      {} as unknown as GitHubOAuthClient,
      {} as unknown as GitHubAppClient,
      'github-client-secret',
    );
    const googleOAuth = new GoogleOAuth(
      database,
      'client',
      'secret',
      'http://placeholder',
      Buffer.alloc(32, 1).toString('base64'),
    );
    phone = new PhoneService(
      database,
      'http://placeholder',
      githubOperations,
      undefined,
      undefined,
      false,
      database,
      undefined,
      googleOAuth,
    );
    const live = new LiveHub();
    daemon = new DaemonService(
      database,
      live,
      undefined,
      undefined,
      false,
      undefined,
      false,
      undefined,
      undefined,
      googleOAuth,
    );
    server = createBeelineServer({ database, auth, phone, daemon, live, googleOAuth });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    accessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
    recipientToken = (await auth.exchangeGitHubOidc('recipient-proof')).accessToken;
    helperToken = (await auth.exchangeDaemonToken(
      (await auth.createDaemonExchange(HELPER)).exchangeToken,
    ))!.daemonToken;
    otherHelperToken = (await auth.exchangeDaemonToken(
      (await auth.createDaemonExchange(OTHER_HELPER)).exchangeToken,
    ))!.daemonToken;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (database) await database.close();
  });

  const operation = (name: string, payload: unknown, token = accessToken) =>
    fetch(`${origin}/v1/phone/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const phoneOperation = async (name: string, payload: unknown, token = accessToken) => {
    const response = await operation(name, payload, token);
    expect([200, 204]).toContain(response.status);
    return response.status === 204 ? undefined : ((await response.json()) as unknown);
  };
  const daemonOperation = async (name: string, payload: unknown, token = helperToken) => {
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  async function connectionReceiptCards() {
    return (
      await database.query<{ author_id: string; text: string; card_type: string }>(
        `SELECT m.author_id,m.text,m.card_type FROM messages m
         JOIN rooms r ON r.id=m.room_id
         WHERE r.workspace_id=$1 AND r.parent_id IS NULL AND m.card_type='connection-receipt'`,
        [WORKSPACE],
      )
    ).rows;
  }

  async function pairOwnerConnector() {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string; status: { status: string } };
    expect(paired.status.status).toBe('installing');
    // The mock helper claims the install, then reports its vault. The vault
    // report path (applyVaultList) is the server's ingest for the helper's
    // future sync report; grants ride the helper's detail surface, so one
    // live grant is seeded here in the shape the helper reports.
    await daemonOperation('installConnector', { connectorId: paired.connectorId });
    await applyVaultList(database, { id: paired.connectorId, owner_identity_id: HUMAN }, [
      {
        reference: 'github.com/acme/tooling',
        service: 'github',
        label: 'Acme tooling',
        fieldNames: ['token'],
        allowedHosts: ['github.com'],
        createdAt: Math.floor(Date.now() / 1000),
        stale: false,
        state: 'active',
      },
    ]);
    await database.query(
      `UPDATE workspace_connections SET grants=$2::jsonb WHERE connector_id=$1::uuid`,
      [
        paired.connectorId,
        JSON.stringify([
          {
            grantId: 'hoots',
            credentialRef: 'github.com/acme/tooling',
            createdAt: Math.floor(Date.now() / 1000),
          },
        ]),
      ],
    );
    return paired.connectorId;
  }

  it('writes owner-approved Squire ledger grants for every owner agent on the machine', async () => {
    const SIBLING = 'd'.repeat(64);
    const MACHINE = 'machine-squire-box';
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Moth','moth')`,
      [SIBLING],
    );
    await database.query(`UPDATE agents SET machine_id=$2 WHERE agent_id=$1`, [HELPER, MACHINE]);
    await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,$3)`, [
      SIBLING,
      HUMAN,
      MACHINE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, SIBLING],
    );

    await pairOwnerConnector();

    const grants = await database.query<{
      agent_id: string;
      requested_by: string;
      decided_by: string;
      status: string;
      kind: string;
      target: string;
      reason: string;
    }>(
      `SELECT agent_id,requested_by,decided_by,status,kind,target,reason FROM agent_grants
       WHERE kind='mcp' AND target='squire' ORDER BY agent_id`,
    );
    expect(grants.rows).toEqual([
      {
        agent_id: HELPER,
        requested_by: HUMAN,
        decided_by: HUMAN,
        status: 'approved',
        kind: 'mcp',
        target: 'squire',
        reason: 'Trusty Squire connected on this machine',
      },
      {
        agent_id: SIBLING,
        requested_by: HUMAN,
        decided_by: HUMAN,
        status: 'approved',
        kind: 'mcp',
        target: 'squire',
        reason: 'Trusty Squire connected on this machine',
      },
    ]);
    expect(grants.rows.map((row) => row.agent_id)).not.toContain(OTHER_HELPER);
  });

  it('pairs, syncs metadata, and scopes the workbench view to the viewer', async () => {
    const connectorId = await pairOwnerConnector();
    const view = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connectors: { connectorId: string; status: { status: string } }[];
      connections: { reference: string; lastSyncedAt?: number; stale?: boolean }[];
    };
    expect(view.connectors).toHaveLength(1);
    expect(view.connectors[0]!.connectorId).toBe(connectorId);
    expect(view.connectors[0]!.status.status).toBe('connected');
    expect(view.connections[0]).toMatchObject({
      reference: 'github.com/acme/tooling',
      // The brand domain the row's mark fetches, derived server-side from the
      // credential's first allowed host.
      faviconDomain: 'github.com',
    });
    expect(view.connections[0]!.stale).toBeFalsy();

    // A different member sees none of this: connections are owner-scoped.
    const otherView = (await phoneOperation(
      'readWorkbench',
      { workspaceId: WORKSPACE },
      recipientToken,
    )) as { connectors: unknown[]; connections: unknown[] };
    expect(otherView.connectors).toEqual([]);
    expect(otherView.connections).toEqual([]);
  });

  it('lists keys in vault created-at order, not by service', async () => {
    const connectorId = await pairOwnerConnector();
    // The helper reports what `vaultConnectionMeta` produced from Squire's
    // ISO-8601 `created_at`: epoch seconds, newest first in the vault.
    const vaultTime = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    await applyVaultList(database, { id: connectorId, owner_identity_id: HUMAN }, [
      {
        reference: 'alpha',
        service: 'alpha',
        label: 'default',
        fieldNames: ['token'],
        allowedHosts: [],
        createdAt: vaultTime('2026-09-14T09:00:00.000Z'),
        stale: false,
        state: 'active',
      },
      {
        reference: 'zeta',
        service: 'zeta',
        label: 'default',
        fieldNames: ['token'],
        allowedHosts: [],
        createdAt: vaultTime('2026-09-17T09:00:00.000Z'),
        stale: false,
        state: 'active',
      },
      {
        reference: 'mu',
        service: 'mu',
        label: 'default',
        fieldNames: ['token'],
        allowedHosts: [],
        createdAt: vaultTime('2026-09-15T09:00:00.000Z'),
        stale: false,
        state: 'active',
      },
      {
        reference: 'beta',
        service: 'beta',
        label: 'default',
        fieldNames: ['token'],
        allowedHosts: [],
        createdAt: vaultTime('2026-09-16T09:00:00.000Z'),
        stale: false,
        state: 'active',
      },
      // The helper could not read this entry's vault created_at (0), so the
      // row falls back to its own created_at instead of sinking to the bottom.
      {
        reference: 'gamma',
        service: 'gamma',
        label: 'default',
        fieldNames: ['token'],
        allowedHosts: [],
        createdAt: 0,
        stale: false,
        state: 'active',
      },
    ]);
    const view = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connections: { reference: string; service: string; label: string }[];
    };
    const ours = view.connections.filter((row) =>
      ['alpha', 'zeta', 'mu', 'beta', 'gamma'].includes(row.reference),
    );
    expect(ours.map((row) => row.reference)).toEqual(['gamma', 'zeta', 'beta', 'mu', 'alpha']);
    expect(ours.every((row) => row.label === 'default')).toBe(true);
  });

  it('reads the workbench when the client sends no workspace id (the settings screen path)', async () => {
    // The Workbench screen navigates with NO route params, so the client sends
    // workspaceId:''. It must NOT be cast to a uuid — the helpers query used to
    // do exactly that and threw `invalid input syntax for type uuid: ""`, which
    // surfaced as "Workbench is unavailable right now" for every member.
    const connectorId = await pairOwnerConnector();
    const response = await operation('readWorkbench', { workspaceId: '' });
    expect(response.status).toBe(200);
    const view = (await response.json()) as {
      connectors: { connectorId: string }[];
      catalog: unknown[];
    };
    expect(view.connectors.map((c) => c.connectorId)).toContain(connectorId);
    expect(view.catalog.length).toBeGreaterThan(0);
  });

  it('pairs a connector when the client sends no workspace id (the connect-screen path)', async () => {
    // The connect screen sends workspaceId:''. pairConnector must derive the
    // Workspace from a viewer/helper co-membership instead of casting '' to a
    // uuid (which threw a 400 "invalid input syntax for type uuid").
    const response = await operation('pairConnector', {
      workspaceId: '',
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    });
    expect(response.status).toBe(200);
    const paired = (await response.json()) as { connectorId: string; status: { status: string } };
    expect(paired.status.status).toBe('installing');
    // And it is readable back through the human-scoped, param-less read.
    const view = (await phoneOperation('readWorkbench', { workspaceId: '' })) as {
      connectors: { connectorId: string }[];
    };
    expect(view.connectors.map((c) => c.connectorId)).toContain(paired.connectorId);
  });

  it('rejects pairing a connector that is not connectable and a helper outside the Workspace', async () => {
    expect(
      (
        await operation('pairConnector', {
          workspaceId: WORKSPACE,
          connectorType: 'wallet',
          helperAgentId: HELPER,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await operation('pairConnector', {
          workspaceId: WORKSPACE,
          connectorType: 'trusty-squire',
          helperAgentId: 'd'.repeat(64),
        })
      ).status,
    ).toBe(503);
  });

  it('records ordinary usage on the key but no longer DMs it to the owner', async () => {
    const connectorId = await pairOwnerConnector();
    const requestId = createHash('sha256').update('turn-quiet').digest('hex');
    await daemonOperation('postConnectionUsage', {
      requestId,
      agentId: HELPER,
      usage: [
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'get_pull_request',
          statusCode: 200,
          bytes: 1200,
        },
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'list_files',
          statusCode: 200,
          bytes: 800,
        },
      ],
    });
    // The key's own record keeps every call.
    const rows = await database.query<{ operation: string; event_class: string | null }>(
      `SELECT r.operation,r.event_class FROM connection_receipts r
       JOIN workspace_connections c ON c.id=r.connection_id
       WHERE c.connector_id=$1::uuid AND r.turn_key=$2`,
      [connectorId, requestId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.event_class === null)).toBe(true);
    // And the owner receives no receipt DM at all.
    const cards = await connectionReceiptCards();
    expect(cards).toHaveLength(0);
  });

  it('hides an empty connector DM, then reveals its repaired identity with the first card', async () => {
    const roomId = await ensureConnectorDirectMessageRoom(
      database,
      WORKSPACE,
      'trusty-squire',
      HUMAN,
    );
    expect(
      (await phone.readChats(WORKSPACE, HUMAN))?.chats.some((chat) => chat.room.id === roomId),
    ).toBe(false);

    const identity = (
      await database.query<{ name: string; handle: string; avatar: string }>(
        `SELECT name,handle,avatar FROM identities WHERE id=$1`,
        [connectorIdentityId('trusty-squire')],
      )
    ).rows[0];
    expect(identity).toEqual({
      name: 'Trusty Squire',
      handle: 'trusty-squire',
      avatar: '/v1/connectors/logo/trusty-squire.svg',
    });

    await pairOwnerConnector();
    await daemonOperation('postConnectionUsage', {
      requestId: createHash('sha256').update('first-visible-receipt').digest('hex'),
      agentId: HELPER,
      usage: [
        {
          ref: 'github.com/acme/tooling',
          operation: 'fetch_credential github.com/acme/tooling',
          eventClass: 'approval',
        },
      ],
    });
    const chat = (await phone.readChats(WORKSPACE, HUMAN))?.chats.find(
      (candidate) => candidate.room.id === roomId,
    );
    expect(chat?.latestMessage?.text).toContain('@bee used Acme tooling');
    expect(chat?.directMessage?.peer).toMatchObject({
      name: 'Trusty Squire',
      handle: 'trusty-squire',
      avatar: 'http://placeholder/v1/connectors/logo/trusty-squire.svg',
    });

    const logo = await fetch(`${origin}/v1/connectors/logo/trusty-squire.svg`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/svg+xml');
    expect(await logo.text()).toContain('aria-label="Trusty Squire"');
    const systemLogo = await fetch(`${origin}/v1/connectors/logo/system.svg`);
    expect(systemLogo.status).toBe(200);
    expect(await systemLogo.text()).toContain('aria-label="System"');
  });

  it('DMs exactly one receipt card for an approval-class event', async () => {
    const connectorId = await pairOwnerConnector();
    const requestId = createHash('sha256').update('turn-approval').digest('hex');
    await daemonOperation('postConnectionUsage', {
      requestId,
      agentId: HELPER,
      usage: [
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'fetch_credential github.com/acme/tooling',
          statusCode: 200,
          bytes: 120,
          eventClass: 'approval',
        },
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'list_files',
          statusCode: 200,
          bytes: 800,
        },
      ],
    });
    const cards = await connectionReceiptCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.author_id).toBe(connectorIdentityId('trusty-squire'));
    expect(cards[0]!.text).toContain('@bee used Acme tooling');
    // The card is about the approval-class event, not the ordinary use.
    expect(cards[0]!.text).toContain('fetch_credential');
  });

  it("aggregates a second approval-class report into the turn's existing card", async () => {
    const connectorId = await pairOwnerConnector();
    const requestId = createHash('sha256').update('turn-batched').digest('hex');
    const approval = {
      ref: 'github.com/acme/tooling',
      service: 'github',
      operation: 'grant_app_access github.com/acme/tooling',
      statusCode: 200,
      bytes: 100,
      eventClass: 'approval' as const,
    };
    await daemonOperation('postConnectionUsage', {
      requestId,
      agentId: HELPER,
      usage: [approval],
    });
    await daemonOperation('postConnectionUsage', {
      requestId,
      agentId: HELPER,
      usage: [
        { ...approval, bytes: 200 },
        // Ordinary use in the same turn neither opens nor restates a card.
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'list_files',
          statusCode: 200,
          bytes: 800,
        },
      ],
    });
    const cards = await connectionReceiptCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toContain('2 calls');
  });

  it('keeps connection detail, ledger, and management sovereign', async () => {
    const connectorId = await pairOwnerConnector();
    await daemonOperation('postConnectionUsage', {
      requestId: createHash('sha256').update('turn-2').digest('hex'),
      agentId: HELPER,
      usage: [
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'get_pull_request',
          statusCode: 200,
          bytes: 1200,
        },
      ],
    });
    const view = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connections: { connectionId: string }[];
    };
    const connectionId = view.connections[0]!.connectionId;
    const detail = (await phoneOperation('readConnectionDetail', {
      workspaceId: WORKSPACE,
      connectionId,
    })) as {
      connection: { reference: string; fieldNames: string[]; createdAt: number };
      grants: { grantId: string }[];
      ledger: { operation: string }[];
    };
    expect(detail.connection.reference).toBe('github.com/acme/tooling');
    expect(detail.connection.fieldNames).toEqual(['token']);
    expect(detail.connection.createdAt).toBeGreaterThan(0);
    expect(detail.grants.map((grant) => grant.grantId)).toEqual(['hoots']);
    expect(detail.ledger).toHaveLength(1);

    // Member B can neither read nor manage member A's connection.
    expect(
      (
        await operation(
          'readConnectionDetail',
          { workspaceId: WORKSPACE, connectionId },
          recipientToken,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await operation(
          'revokeConnectionGrants',
          { workspaceId: WORKSPACE, connectionId },
          recipientToken,
        )
      ).status,
    ).toBe(403);
    expect(
      (await operation('unpairConnector', { workspaceId: WORKSPACE, connectorId }, recipientToken))
        .status,
    ).toBe(403);

    // A helper that does not serve the connector cannot report against it:
    // the usage resolves to nothing, so no ledger row and no receipt card.
    await daemonOperation(
      'postConnectionUsage',
      {
        requestId: createHash('sha256').update('foreign-turn').digest('hex'),
        agentId: OTHER_HELPER,
        usage: [{ ref: 'github.com/acme/tooling', service: 'github', operation: 'x' }],
      },
      otherHelperToken,
    );
    const foreign = await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM connection_receipts WHERE connection_id=$1::uuid`,
      [connectionId],
    );
    expect(foreign.rows[0]!.count).toBe('1');
  });

  it('revokes grants and unpairing clears connections, receipts, and eventually the row', async () => {
    const connectorId = await pairOwnerConnector();
    const view = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connections: { connectionId: string }[];
    };
    const connectionId = view.connections[0]!.connectionId;
    const revoked = (await phoneOperation('revokeConnectionGrants', {
      workspaceId: WORKSPACE,
      connectionId,
    })) as { revoked: number; pending?: number };
    expect(revoked).toEqual({ revoked: 0, failed: 0, pending: 1 });
    const pendingGrants = await database.query<{ grants: Array<Record<string, unknown>> }>(
      `SELECT grants FROM workspace_connections WHERE id=$1::uuid`,
      [connectionId],
    );
    expect(pendingGrants.rows[0]!.grants[0]).toMatchObject({ grantId: 'hoots' });
    expect(pendingGrants.rows[0]!.grants[0]!.revokedAt).toBeUndefined();
    expect(pendingGrants.rows[0]!.grants[0]!.revokingAt).toEqual(expect.any(Number));
    // The helper is asked to drop its egress grants on the next poll, and the
    // queue stays until that helper confirms.
    const queue = await daemonOperation('getConnectorAssignments', {});
    const kinds = (queue.body as { assignments?: { kind: string }[] }).assignments?.map(
      (a) => a.kind,
    );
    expect(kinds).toContain('revoke-grants');
    const retry = await daemonOperation('getConnectorAssignments', {});
    expect(
      (retry.body as { assignments?: { kind: string }[] }).assignments?.map((a) => a.kind),
    ).toContain('revoke-grants');
    await daemonOperation('revokeConnectionGrants', { ref: 'github.com/acme/tooling' });
    const confirmed = await database.query<{ grants: Array<Record<string, unknown>> }>(
      `SELECT grants FROM workspace_connections WHERE id=$1::uuid`,
      [connectionId],
    );
    expect(confirmed.rows[0]!.grants[0]!.revokedAt).toEqual(expect.any(Number));
    expect(confirmed.rows[0]!.grants[0]!.revokingAt).toBeUndefined();

    await phoneOperation('unpairConnector', { workspaceId: WORKSPACE, connectorId });
    const cleared = await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM workspace_connections WHERE connector_id=$1::uuid`,
      [connectorId],
    );
    expect(cleared.rows[0]!.count).toBe('0');
    const receipts = await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM connection_receipts WHERE owner_identity_id=$1`,
      [HUMAN],
    );
    expect(receipts.rows[0]!.count).toBe('0');
    // The uninstall assignment reaches the helper; its status poll is the
    // ack path that reaps the row.
    const after = await daemonOperation('getConnectorAssignments', {});
    expect(
      (after.body as { assignments?: { kind: string }[] }).assignments?.map((a) => a.kind),
    ).toContain('uninstall');
    await daemonOperation('getConnectorStatus', {});
    const gone = await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM workspace_connectors WHERE id=$1::uuid`,
      [connectorId],
    );
    expect(gone.rows[0]!.count).toBe('0');
  });

  it('re-pairs a stale disconnected row as a fresh install instead of leaving it dead', async () => {
    // A previous pairing attempt left a stale row (the helper never acked the
    // uninstall, so the reap never ran): disconnected, no steps, an error
    // line, a leftover sync op, and a connected_at timestamp. Re-pairing must
    // re-arm it exactly like a fresh insert — the connect screen's only path
    // back, since a disconnected row has no unpair UI.
    const staleId = randomUUID();
    await database.query(
      `INSERT INTO workspace_connectors(
         id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,
         status,status_steps,status_error,pending_ops,connected_at
       ) VALUES ($1,$2,$3,'trusty-squire',$4,$5,'disconnected','[]'::jsonb,
                 'last install failed','["sync"]'::jsonb,now())`,
      [staleId, WORKSPACE, HUMAN, HELPER, HELPER],
    );
    const repaired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as {
      connectorId: string;
      status: { status: string; steps: { label: string; status: string }[]; errorMessage?: string };
    };
    expect(repaired.connectorId).toBe(staleId);
    expect(repaired.status.status).toBe('installing');
    expect(repaired.status.steps).toEqual([
      { label: 'Install on helper', status: 'pending' },
      { label: 'Connect provider account', status: 'pending' },
    ]);
    expect(repaired.status.errorMessage).toBeUndefined();

    const row = await database.query<{
      status_error: string | null;
      connected_at: Date | null;
      pending_ops: string[];
      helper_agent_id: string;
    }>(
      `SELECT status_error,connected_at,pending_ops,helper_agent_id
       FROM workspace_connectors WHERE id=$1::uuid`,
      [staleId],
    );
    expect(row.rows[0]!.status_error).toBeNull();
    expect(row.rows[0]!.connected_at).toBeNull();
    expect(row.rows[0]!.pending_ops).toEqual([]);
    expect(row.rows[0]!.helper_agent_id).toBe(HELPER);

    // The helper daemon derives its assignments from the re-armed row: the
    // install assignment arrives on its next poll.
    const queue = await daemonOperation('getConnectorAssignments', {});
    expect(
      (queue.body as { assignments?: { kind: string; connectorId: string }[] }).assignments,
    ).toContainEqual({
      kind: 'install',
      connectorId: staleId,
      connectorType: 'trusty-squire',
      pairingGeneration: 2,
    });
  });

  it('re-pairing a connected connector starts a fresh install again', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await daemonOperation('installConnector', { connectorId: paired.connectorId });
    const connected = await database.query<{ status: string }>(
      `SELECT status FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(connected.rows[0]!.status).toBe('connected');

    const again = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string; status: { status: string; steps: unknown[] } };
    expect(again.connectorId).toBe(paired.connectorId);
    expect(again.status.status).toBe('installing');
    expect(again.status.steps.length).toBeGreaterThan(0);
  });

  it('drops the previous attempt\u2019s sign-in surface when connect needed no ceremony', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await daemonOperation('installConnector', {
      connectorId: paired.connectorId,
      signIn: { method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' },
    });
    const withCeremony = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connectors: { connectorId: string; status: { signIn?: { url: string } } }[];
    };
    expect(
      withCeremony.connectors.find((row) => row.connectorId === paired.connectorId)?.status.signIn
        ?.url,
    ).toBe('https://tunnel.test/#p=hunter22');

    // That tunnel died with the connect process. The shared profile already
    // carries the session, so the next install prints no ceremony at all —
    // the phone must not keep offering the dead page.
    await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    });
    await daemonOperation('installConnector', { connectorId: paired.connectorId });
    const after = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connectors: { connectorId: string; status: { status: string; signIn?: { url: string } } }[];
    };
    const row = after.connectors.find((entry) => entry.connectorId === paired.connectorId);
    expect(row?.status.status).toBe('connected');
    expect(row?.status.signIn).toBeUndefined();
  });

  it('a steps-only progress report keeps the live ceremony; the run\u2019s verdict clears it', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    const signInUrl = async () => {
      const view = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
        connectors: { connectorId: string; status: { signIn?: { url: string } } }[];
      };
      return view.connectors.find((row) => row.connectorId === paired.connectorId)?.status.signIn
        ?.url;
    };
    await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'done' }],
      signIn: { method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' },
    });
    expect(await signInUrl()).toBe('https://tunnel.test/#p=hunter22');

    // The same run posting later progress says nothing about its surface.
    await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'paired to workspace', status: 'pending' }],
    });
    expect(await signInUrl()).toBe('https://tunnel.test/#p=hunter22');

    // A LATER run that printed no ceremony says so, and the dead tunnel goes.
    await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      signIn: null,
    });
    expect(await signInUrl()).toBeUndefined();
  });

  it('an explicit re-pair drops the previous ceremony instead of re-offering it', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await daemonOperation('installConnector', {
      connectorId: paired.connectorId,
      signIn: { method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' },
    });
    await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    });
    const view = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connectors: { connectorId: string; status: { status: string; signIn?: { url: string } } }[];
    };
    const row = view.connectors.find((entry) => entry.connectorId === paired.connectorId);
    expect(row?.status.status).toBe('installing');
    expect(row?.status.signIn).toBeUndefined();
  });

  it('answers the connector status the helper named, not the oldest row', async () => {
    // A helper carries the four Google tool rows beside its Squire row, and
    // the Google ones are created first. An unscoped read would hand the
    // helper another connector's state for its own assignment.
    const google = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'google-gmail',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    const squire = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await daemonOperation('postConnectorStatus', {
      connectorId: squire.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      signIn: { method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' },
    });

    const unscoped = await daemonOperation('getConnectorStatus', {});
    expect(unscoped.body.connectorId).toBe(google.connectorId);

    const scoped = await daemonOperation('getConnectorStatus', {
      connectorId: squire.connectorId,
    });
    expect(scoped.body.connectorId).toBe(squire.connectorId);
    expect(scoped.body.signIn).toEqual({
      method: 'streamed-page',
      url: 'https://tunnel.test/#p=hunter22',
    });
  });

  it('pairs Tailscale on the selected helper and queues its installer', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string; status: { status: string } };

    expect(paired.status.status).toBe('installing');
    const queue = await daemonOperation('getConnectorAssignments', {});
    expect(queue.body.assignments).toContainEqual({
      kind: 'install',
      connectorId: paired.connectorId,
      connectorType: 'tailscale',
      pairingGeneration: 1,
    });
    const view = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      catalog: { connectorType: string; available: boolean }[];
    };
    expect(view.catalog).toContainEqual(
      expect.objectContaining({ connectorType: 'tailscale', available: true }),
    );
  });

  it('pairing one Google tool queues only that product', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'google-gmail',
      helperAgentId: HELPER,
    })) as { connectorId: string };

    const rows = await database.query<{ connector_type: string; status: string }>(
      `SELECT connector_type,status FROM workspace_connectors
       WHERE workspace_id=$1 AND owner_identity_id=$2 AND machine_id=$3
         AND connector_type LIKE 'google-%'`,
      [WORKSPACE, HUMAN, HELPER],
    );
    const byType = Object.fromEntries(rows.rows.map((row) => [row.connector_type, row.status]));
    expect(Object.keys(byType)).toEqual(['google-gmail']);
    expect(byType['google-gmail']).toBe('installing');
    const queue = await daemonOperation('getConnectorAssignments', {});
    const kinds = (
      queue.body as { assignments?: { kind: string; connectorType: string }[] }
    ).assignments?.filter((assignment) => assignment.connectorType?.startsWith('google-'));
    expect(kinds?.map((assignment) => assignment.connectorType)).toEqual(['google-gmail']);
    expect(kinds?.every((assignment) => assignment.kind === 'install')).toBe(true);
  });

  it('re-pairing one Google tool leaves a connected sibling alone', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'google-gmail',
      helperAgentId: HELPER,
    })) as { connectorId: string };

    await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'google-youtube',
      helperAgentId: HELPER,
    });
    await database.query(
      `UPDATE workspace_connectors SET status='connected', connected_at=now()
       WHERE workspace_id=$1 AND owner_identity_id=$2 AND machine_id=$3
         AND connector_type='google-youtube'`,
      [WORKSPACE, HUMAN, HELPER],
    );

    const again = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'google-gmail',
      helperAgentId: HELPER,
    })) as { connectorId: string; status: { status: string } };
    expect(again.connectorId).toBe(paired.connectorId);
    expect(again.status.status).toBe('installing');

    const rows = await database.query<{
      connector_type: string;
      status: string;
      connected_at: Date | null;
    }>(
      `SELECT connector_type,status,connected_at FROM workspace_connectors
       WHERE workspace_id=$1 AND owner_identity_id=$2 AND machine_id=$3
         AND connector_type LIKE 'google-%'`,
      [WORKSPACE, HUMAN, HELPER],
    );
    const byType = Object.fromEntries(
      rows.rows.map((row) => [
        row.connector_type,
        { status: row.status, connectedAt: row.connected_at },
      ]),
    );
    // The connected sibling keeps its live grant untouched.
    expect(byType['google-youtube']!.status).toBe('connected');
    expect(byType['google-youtube']!.connectedAt).not.toBeNull();
    expect(byType['google-gmail']!.status).toBe('installing');
    expect(byType['google-calendar']).toBeUndefined();
    expect(byType['google-drive']).toBeUndefined();
  });

  it('keeps the connector receipt DM read-only for everyone but the connector identity', async () => {
    const connectorId = await pairOwnerConnector();
    await daemonOperation('postConnectionUsage', {
      requestId: createHash('sha256').update('turn-3').digest('hex'),
      agentId: HELPER,
      usage: [
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'fetch_credential github.com/acme/tooling',
          eventClass: 'approval',
        },
      ],
    });
    const room = await database.query<{ id: string }>(
      `SELECT r.id FROM rooms r
       JOIN messages m ON m.room_id=r.id
       WHERE r.workspace_id=$1 AND m.card_type='connection-receipt' LIMIT 1`,
      [WORKSPACE],
    );
    const response = await operation('sendRoomMessage', {
      roomId: room.rows[0]!.id,
      text: 'hello?',
    });
    expect(response.status).toBe(403);
  });

  it('routes YouTube lifecycle through its adapter: owner unpairs, another requester cannot', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'google-youtube',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await database.query(
      `UPDATE workspace_connectors SET status='connected', connected_at=now()
       WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    const queue = await daemonOperation('getConnectorAssignments', {});
    expect(
      (queue.body as { assignments?: { kind: string; connectorType: string }[] }).assignments,
    ).toContainEqual({
      kind: 'refresh-google-grant',
      connectorId: paired.connectorId,
      connectorType: 'google-youtube',
    });
    expect(
      (
        await operation(
          'unpairConnector',
          { workspaceId: WORKSPACE, connectorId: paired.connectorId },
          recipientToken,
        )
      ).status,
    ).toBe(403);
    await phoneOperation('unpairConnector', {
      workspaceId: WORKSPACE,
      connectorId: paired.connectorId,
    });
    const row = await database.query<{ status: string }>(
      `SELECT status FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('disconnected');
  });

  it('does not copy a helper vault onto a Workbench row the helper owner does not own', async () => {
    await pairOwnerConnector();
    const foreignId = randomUUID();
    await database.query(
      `INSERT INTO workspace_connectors(
         id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,
         status,status_steps
       ) VALUES ($1,$2,$3,'trusty-squire',$4,$4,'connected','[]'::jsonb)`,
      [foreignId, WORKSPACE, RECIPIENT, HELPER],
    );
    await daemonOperation('postConnectorVault', {
      connections: [
        {
          reference: 'leaked.example/key',
          service: 'github',
          label: 'leaked',
          fieldNames: ['token'],
          allowedHosts: ['github.com'],
          createdAt: Math.floor(Date.now() / 1000),
          stale: false,
          state: 'active',
        },
      ],
    });
    const ownerView = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connections: { reference: string }[];
    };
    expect(ownerView.connections.map((row) => row.reference)).toEqual(['leaked.example/key']);
    const otherView = (await phoneOperation(
      'readWorkbench',
      { workspaceId: WORKSPACE },
      recipientToken,
    )) as { connections: { reference: string }[] };
    expect(otherView.connections).toEqual([]);
  });

  it('ignores a late install report after unpair', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await phoneOperation('unpairConnector', {
      workspaceId: WORKSPACE,
      connectorId: paired.connectorId,
    });
    const late = await daemonOperation('installConnector', {
      connectorId: paired.connectorId,
      pairingGeneration: 1,
    });
    expect(late.status).toBe(404);
    const row = await database.query<{ status: string }>(
      `SELECT status FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('disconnected');
  });

  it('a stale status report cannot overwrite a disconnect', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      pairingGeneration: 1,
    });
    await phoneOperation('unpairConnector', {
      workspaceId: WORKSPACE,
      connectorId: paired.connectorId,
    });
    const late = await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'trusty-squire failed', status: 'failed' }],
      errorMessage: 'late helper error',
      pairingGeneration: 1,
    });
    expect(late.status).toBe(404);
    const row = await database.query<{ status: string; status_error: string | null }>(
      `SELECT status,status_error FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('disconnected');
    expect(row.rows[0]!.status_error).toBeNull();
  });

  it('a stale status report cannot overwrite a re-pair', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    });
    const late = await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'trusty-squire failed', status: 'failed' }],
      errorMessage: 'stale generation error',
      pairingGeneration: 1,
    });
    expect(late.status).toBe(404);
    const row = await database.query<{
      status: string;
      status_error: string | null;
      pairing_generation: number;
    }>(
      `SELECT status,status_error,pairing_generation FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('installing');
    expect(row.rows[0]!.status_error).toBeNull();
    expect(row.rows[0]!.pairing_generation).toBe(2);
  });

  it('a generation-less status report cannot overwrite a re-pair', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    });
    const late = await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'trusty-squire failed', status: 'failed' }],
      errorMessage: 'stale generation-less error',
    });
    expect(late.status).toBe(404);
    const row = await database.query<{
      status: string;
      status_error: string | null;
      pairing_generation: number;
    }>(
      `SELECT status,status_error,pairing_generation FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('installing');
    expect(row.rows[0]!.status_error).toBeNull();
    expect(row.rows[0]!.pairing_generation).toBe(2);
  });

  it('a generation-less status report still updates an eligible generation-1 row', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    const report = await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
    });
    expect(report.status).toBe(200);
    const row = await database.query<{
      status: string;
      status_steps: { label: string; status: string }[];
      pairing_generation: number;
    }>(
      `SELECT status,status_steps,pairing_generation FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('installing');
    expect(row.rows[0]!.status_steps).toEqual([
      { label: 'waiting for sign-in', status: 'pending' },
    ]);
    expect(row.rows[0]!.pairing_generation).toBe(1);
  });

  it('an explicit current-generation status report succeeds; stale generations and disconnected rows remain rejected', async () => {
    const paired = (await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    const first = await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      pairingGeneration: 1,
    });
    expect(first.status).toBe(200);

    await phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    });
    const current = await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      pairingGeneration: 2,
    });
    expect(current.status).toBe(200);

    const stale = await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'trusty-squire failed', status: 'failed' }],
      errorMessage: 'stale generation error',
      pairingGeneration: 1,
    });
    expect(stale.status).toBe(404);

    await phoneOperation('unpairConnector', {
      workspaceId: WORKSPACE,
      connectorId: paired.connectorId,
    });
    const disconnected = await daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'trusty-squire failed', status: 'failed' }],
      errorMessage: 'late helper error',
      pairingGeneration: 2,
    });
    expect(disconnected.status).toBe(404);

    const row = await database.query<{
      status: string;
      status_error: string | null;
      pairing_generation: number;
      status_steps: { label: string; status: string }[];
    }>(
      `SELECT status,status_error,pairing_generation,status_steps FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('disconnected');
    expect(row.rows[0]!.status_error).toBeNull();
    expect(row.rows[0]!.pairing_generation).toBe(2);
    expect(row.rows[0]!.status_steps).toEqual([]);
  });
});
