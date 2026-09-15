import { createHash } from 'node:crypto';
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
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import { applyVaultList, connectorIdentityId } from './workbench.js';

const HUMAN = createHash('sha256').update('github:owner').digest('hex');
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
      [HUMAN, HELPER, createHash('sha256').update('github:recipient').digest('hex'), OTHER_HELPER],
    );
    await database.query(
      `INSERT INTO agents(agent_id,owner_id) VALUES($1,$2),($3,$4)`,
      [
        HELPER,
        HUMAN,
        OTHER_HELPER,
        createHash('sha256').update('github:recipient').digest('hex'),
      ],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),($1,NULL,$5,'member')`,
      [
        WORKSPACE,
        HUMAN,
        createHash('sha256').update('github:recipient').digest('hex'),
        HELPER,
        OTHER_HELPER,
      ],
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
    phone = new PhoneService(database, 'http://placeholder', githubOperations);
    const live = new LiveHub();
    daemon = new DaemonService(database, live);
    server = createBeelineServer({ database, auth, phone, daemon, live });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    accessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
    recipientToken = (await auth.exchangeGitHubOidc('recipient-proof')).accessToken;
    helperToken = (
      await auth.exchangeDaemonToken((await auth.createDaemonExchange(HELPER)).exchangeToken)
    )!.daemonToken;
    otherHelperToken = (
      await auth.exchangeDaemonToken((await auth.createDaemonExchange(OTHER_HELPER)).exchangeToken)
    )!.daemonToken;
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
    await applyVaultList(
      database,
      { id: paired.connectorId, owner_identity_id: HUMAN },
      [
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
      ],
    );
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

  it('pairs, syncs metadata, and scopes the workbench view to the viewer', async () => {
    const connectorId = await pairOwnerConnector();
    const view = (await phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connectors: { connectorId: string; status: { status: string } }[];
      connections: { reference: string; lastSyncedAt?: number; stale?: boolean }[];
    };
    expect(view.connectors).toHaveLength(1);
    expect(view.connectors[0]!.connectorId).toBe(connectorId);
    expect(view.connectors[0]!.status.status).toBe('connected');
    expect(view.connections[0]).toMatchObject({ reference: 'github.com/acme/tooling' });
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

  it('rejects pairing a connector that is not connectable and a helper outside the Workspace', async () => {
    expect((await operation('pairConnector', { workspaceId: WORKSPACE, connectorType: 'wallet', helperAgentId: HELPER })).status).toBe(503);
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

  it('aggregates a second approval-class report into the turn\'s existing card', async () => {
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
      connection: { reference: string };
      grants: { grantId: string }[];
      ledger: { operation: string }[];
    };
    expect(detail.connection.reference).toBe('github.com/acme/tooling');
    expect(detail.grants.map((grant) => grant.grantId)).toEqual(['hoots']);
    expect(detail.ledger).toHaveLength(1);

    // Member B can neither read nor manage member A's connection.
    expect(
      (
        await operation('readConnectionDetail', { workspaceId: WORKSPACE, connectionId }, recipientToken)
      ).status,
    ).toBe(403);
    expect(
      (
        await operation('revokeConnectionGrants', { workspaceId: WORKSPACE, connectionId }, recipientToken)
      ).status,
    ).toBe(403);
    expect(
      (
        await operation('unpairConnector', { workspaceId: WORKSPACE, connectorId }, recipientToken)
      ).status,
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
    })) as { revoked: number };
    expect(revoked.revoked).toBe(1);
    // The helper is asked to drop its egress grants on the next poll.
    const queue = await daemonOperation('getConnectorAssignments', {});
    const kinds = (queue.body as { assignments?: { kind: string }[] }).assignments?.map((a) => a.kind);
    expect(kinds).toContain('revoke-grants');

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
    expect((after.body as { assignments?: { kind: string }[] }).assignments?.map((a) => a.kind)).toContain(
      'uninstall',
    );
    await daemonOperation('getConnectorStatus', {});
    const gone = await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM workspace_connectors WHERE id=$1::uuid`,
      [connectorId],
    );
    expect(gone.rows[0]!.count).toBe('0');
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
});
