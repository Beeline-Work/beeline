import { readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { createIdentity, isRoomView } from '@beeline/buzz-client';
import { nip98AuthHeader } from '@beeline/nostr';
import { Pool } from 'pg';
import type { DatabaseQueryable } from '../src/database.js';
import { TokenRegistry } from '../src/registry.js';
import { CHAT_LIST_SQL, ROOM_PAINT_SQL, RoomIndexer } from '../src/room-indexer.js';
import { createRegistrationServer } from '../src/server.js';

const LIVE_ORIGIN = 'https://room-indexer-live-proof.invalid';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`set ${name}`);
  return value;
}

function uuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`${name} must be a lower-case UUID`);
  }
  return value;
}

async function unusedPort(): Promise<number> {
  const socket = createNetServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve proof port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

async function main(): Promise<void> {
  const databaseUrl = required('LIVE_DATABASE_URL');
  const identityPath = required('LIVE_IDENTITY_FILE');
  const roomId = uuid(required('LIVE_ROOM_ID'), 'LIVE_ROOM_ID');
  const stored = JSON.parse(await readFile(identityPath, 'utf8')) as {
    agent?: { publicKey?: unknown; secretKeyHex?: unknown };
  };
  if (
    typeof stored.agent?.publicKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(stored.agent.publicKey) ||
    typeof stored.agent.secretKeyHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(stored.agent.secretKeyHex)
  ) {
    throw new Error('LIVE_IDENTITY_FILE does not contain a valid runtime identity');
  }
  const member = {
    publicKey: stored.agent.publicKey,
    secretKey: Uint8Array.from(Buffer.from(stored.agent.secretKeyHex, 'hex')),
  };
  const outsider = createIdentity('room-indexer-live-outsider');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let physicalQueries = 0;
  const physicalQueryDurations: number[] = [];
  let physicalDatabaseConnections = 0;
  let physicalHttpConnections = 0;
  pool.on('connect', () => { physicalDatabaseConnections += 1; });
  const database: DatabaseQueryable = {
    query: async <Row>(text: string, values?: unknown[]) => {
      physicalQueries += 1;
      const startedAt = performance.now();
      try {
        const result = await pool.query(text, values);
        return { rows: result.rows as Row[] };
      } finally {
        physicalQueryDurations.push(performance.now() - startedAt);
      }
    },
  };
  const indexer = new RoomIndexer(database);
  const server = createRegistrationServer(await TokenRegistry.load(), {
    indexer: {
      publicOrigin: LIVE_ORIGIN,
      readWorkspaces: (pubkey) => indexer.readWorkspaces(pubkey),
      readWorkspace: (workspaceId, pubkey) => indexer.readWorkspace(workspaceId, pubkey),
      readChats: (workspaceId, pubkey) => indexer.readChats(workspaceId, pubkey),
      readAgent: (workspaceId, agentPubkey, pubkey) =>
        indexer.readAgent(workspaceId, agentPubkey, pubkey),
      readRoom: (id, pubkey) => indexer.readRoom(id, pubkey),
      readCorners: (id, pubkey) => indexer.readCorners(id, pubkey),
      readHistory: (id, pubkey, before) => indexer.readHistory(id, pubkey, before),
      readInvite: (tokenHash, pubkey) => indexer.readInvite(tokenHash, pubkey),
      log: (line) => {
        if (line.includes('failed')) process.stderr.write(`${line}\n`);
      },
    },
  });
  const databaseConnectStartedAt = performance.now();
  await pool.query('SELECT 1');
  const databaseConnectMs = performance.now() - databaseConnectStartedAt;
  if (process.env.LIVE_EXPLAIN === '1') {
    const explainChats = process.env.LIVE_EXPLAIN_SURFACE === 'chats';
    const workspaceId = process.env.LIVE_WORKSPACE_ID?.trim();
    if (explainChats && !workspaceId) throw new Error('set LIVE_WORKSPACE_ID to explain chats');
    const explained = await pool.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${explainChats ? CHAT_LIST_SQL : ROOM_PAINT_SQL}`,
      explainChats
        ? [workspaceId, member.publicKey, 200, 4]
        : [roomId, member.publicKey, 120, 40],
    );
    const document = explained.rows[0]?.['QUERY PLAN'] as
      | [{ Plan?: Record<string, unknown>; 'Execution Time'?: number }]
      | undefined;
    const slow: Array<Record<string, unknown>> = [];
    const visit = (node: Record<string, unknown>, depth = 0): void => {
      const elapsed = Number(node['Actual Total Time'] ?? 0);
      const loops = Number(node['Actual Loops'] ?? 0);
      const effective = elapsed * loops;
      if (elapsed >= 5 || effective >= 10) {
        slow.push({
          depth,
          node: node['Node Type'],
          relationship: node['Parent Relationship'],
          relation: node['Relation Name'],
          index: node['Index Name'],
          elapsedMs: elapsed,
          effectiveMs: Number(effective.toFixed(3)),
          loops,
          rows: node['Actual Rows'],
          removed: node['Rows Removed by Filter'],
        });
      }
      if (Array.isArray(node.Plans)) {
        for (const child of node.Plans) visit(child as Record<string, unknown>, depth + 1);
      }
    };
    if (document?.[0]?.Plan) visit(document[0].Plan);
    process.stderr.write(`${JSON.stringify({
      executionMs: document?.[0]?.['Execution Time'],
      slowNodes: slow.sort((left, right) => Number(right.effectiveMs) - Number(left.effectiveMs)),
    }, null, 2)}\n`);
  }
  server.on('connection', () => { physicalHttpConnections += 1; });
  const port = await unusedPort();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const requestPath = async (path: string, identity: typeof member) => {
    const startedAt = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: {
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          `${LIVE_ORIGIN}${path}`,
          'GET',
        ),
        connection: 'close',
      },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      bytes,
      latencyMs: performance.now() - startedAt,
      body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    };
  };
  const requestRoom = (id: string, identity: typeof member) =>
    requestPath(`/room/${id}`, identity);

  try {
    const initialQueries = physicalQueries;
    const initialQueryDurations = physicalQueryDurations.length;
    const initialHttpConnections = physicalHttpConnections;
    const room = await requestRoom(roomId, member);
    if (room.status !== 200 || !isRoomView(room.body)) {
      throw new Error(`live Room paint failed with status ${room.status}`);
    }
    const roomQueries = physicalQueries - initialQueries;
    const roomSqlMs = physicalQueryDurations
      .slice(initialQueryDurations)
      .reduce((total, duration) => total + duration, 0);
    const roomHttpConnections = physicalHttpConnections - initialHttpConnections;
    if (roomQueries !== 1 || roomHttpConnections !== 1) {
      throw new Error(
        `cold Room used ${roomQueries} SQL statements and ${roomHttpConnections} HTTP connections`,
      );
    }

    const outsiderRoom = await requestRoom(roomId, outsider);
    const missingRoom = await requestRoom('00000000-0000-4000-8000-000000000001', outsider);
    const outsiderBody = JSON.stringify(outsiderRoom.body);
    const missingBody = JSON.stringify(missingRoom.body);
    if (
      outsiderRoom.status !== 404 ||
      missingRoom.status !== 404 ||
      outsiderBody !== missingBody
    ) {
      throw new Error('live membership gate enumerates Room existence');
    }

    const otherSurfaces: Array<Record<string, unknown>> = [];
    const workspaceId = process.env.LIVE_WORKSPACE_ID?.trim();
    const cornerId = process.env.LIVE_CORNER_ID?.trim();
    const paths = [
      ...(workspaceId
        ? ['/workspaces', `/workspace/${workspaceId}`, `/workspace/${workspaceId}/chats`]
        : []),
      ...(cornerId ? [`/room/${cornerId}`] : []),
    ];
    for (const path of paths) {
      const queriesBefore = physicalQueries;
      const queryDurationsBefore = physicalQueryDurations.length;
      const connectionsBefore = physicalHttpConnections;
      const surface = await requestPath(path, member);
      otherSurfaces.push({
        path,
        status: surface.status,
        latencyMs: Number(surface.latencyMs.toFixed(1)),
        payloadBytes: surface.bytes.byteLength,
        physicalSqlStatements: physicalQueries - queriesBefore,
        sqlMs: Number(physicalQueryDurations.slice(queryDurationsBefore)
          .reduce((total, duration) => total + duration, 0).toFixed(1)),
        physicalHttpConnections: physicalHttpConnections - connectionsBefore,
      });
    }

    process.stdout.write(`${JSON.stringify({
      roomId,
      status: room.status,
      latencyMs: Number(room.latencyMs.toFixed(1)),
      payloadBytes: room.bytes.byteLength,
      messages: room.body.messages.length,
      members: room.body.members.length,
      corners: room.body.corners.length,
      authenticatedRequests: 1,
      physicalHttpConnections: roomHttpConnections,
      physicalSqlStatements: roomQueries,
      sqlMs: Number(roomSqlMs.toFixed(1)),
      physicalDatabaseConnections,
      databaseConnectMs: Number(databaseConnectMs.toFixed(1)),
      nonMemberStatus: outsiderRoom.status,
      missingRoomStatus: missingRoom.status,
      nonEnumeratingBodyEqual: outsiderBody === missingBody,
      otherSurfaces,
    })}\n`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
