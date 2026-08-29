import { randomUUID } from 'node:crypto';

const origin = process.env.BUZZY_LOCAL_RELAY_ORIGIN ?? 'http://127.0.0.1:3010';
const parsedOrigin = new URL(origin);
const relayHost = process.env.BUZZY_LOCAL_RELAY_HOST ?? parsedOrigin.host;

if (parsedOrigin.origin !== origin || parsedOrigin.protocol !== 'http:') {
  throw new Error('BUZZY_LOCAL_RELAY_ORIGIN must be an exact local HTTP origin');
}

async function main(): Promise<void> {
  const { createBuzzClient, createIdentity, RoomViewClient, RoomViewHttpError } =
    await import('@beeline/buzz-client');

  const reader = createIdentity('local-room-indexer-proof');
  // The local relay can be exposed on a different test port while retaining
  // its seeded authority. The transport URL and relay Host header are thus
  // intentionally separate, but both are caller-supplied local values.
  const relay = createBuzzClient({
    baseUrl: parsedOrigin.origin,
    host: relayHost,
    identity: reader,
    batchQueries: true,
  });
  const roomId = await relay.createChannel(`local-indexer-${randomUUID()}`);
  const client = new RoomViewClient({ baseUrl: parsedOrigin.origin, identity: reader });
  const deadline = Date.now() + 15_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const view = await client.room(roomId);
      process.stdout.write(
        `${JSON.stringify({ origin: parsedOrigin.origin, roomId, roomName: view.room.name, status: 200 })}\n`,
      );
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof RoomViewHttpError) || error.status !== 404) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(
    `local RoomView endpoint did not project ${roomId}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

void main();
