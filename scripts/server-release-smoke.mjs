import { pathToFileURL } from 'node:url';

export const SERVER_BOOT_BUDGET_MS = 8 * 60_000;
export const ROOM_READ_BUDGET_MS = 2_000;

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function json(response, label) {
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}`);
  return response.json();
}

export async function runServerReleaseSmoke({
  origin,
  expectedVersion,
  expectedSha,
  reviewSecret,
  bootBudgetMs = SERVER_BOOT_BUDGET_MS,
  roomReadBudgetMs = ROOM_READ_BUDGET_MS,
  pollIntervalMs = 5_000,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const deadline = now() + bootBudgetMs;
  let health;
  let lastFailure = 'server has not answered';
  while (now() < deadline) {
    try {
      const response = await fetchImpl(`${origin}/health`, {
        signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - now()))),
      });
      if (response.ok) {
        const candidate = await response.json();
        if (
          candidate?.ok === true &&
          Number.isFinite(candidate?.database?.pool?.size) &&
          Number.isFinite(candidate?.database?.pool?.inUse) &&
          Number.isFinite(candidate?.database?.pool?.waiting) &&
          (candidate?.database?.oldestActiveQueryAgeMs === null ||
            Number.isFinite(candidate?.database?.oldestActiveQueryAgeMs))
        ) {
          const versionResponse = await fetchImpl(`${origin}/version`, {
            signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - now()))),
          });
          if (versionResponse.ok) {
            const live = await versionResponse.json();
            if (live.version === expectedVersion && live.sourceSha === expectedSha) {
              health = candidate;
              break;
            }
            lastFailure = `waiting for ${expectedVersion}/${expectedSha}; live is ${live.version}/${live.sourceSha}`;
          } else lastFailure = `version check returned HTTP ${versionResponse.status}`;
        } else lastFailure = 'health response omitted database pool diagnostics';
      } else lastFailure = `health returned HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await pause(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
  if (!health)
    throw new Error(`server did not become healthy within ${bootBudgetMs}ms: ${lastFailure}`);

  const session = await json(
    await fetchImpl(`${origin}/v1/auth/review/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: reviewSecret }),
    }),
    'review identity exchange',
  );
  if (typeof session.accessToken !== 'string') throw new Error('review exchange returned no token');
  const authenticated = (path) =>
    fetchImpl(`${origin}${path}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
  const workspaces = await json(await authenticated('/v1/phone/workspaces'), 'Workspace read');
  const workspaceId = workspaces.workspaces?.[0]?.id;
  if (typeof workspaceId !== 'string') throw new Error('review identity has no Workspace');
  const chats = await json(
    await authenticated(`/v1/phone/workspaces/${workspaceId}/chats`),
    'Room list read',
  );
  const roomId = chats.chats?.find((chat) => typeof chat?.room?.id === 'string')?.room.id;
  if (typeof roomId !== 'string') throw new Error('review identity has no Room');

  const startedAt = now();
  const room = await json(
    await fetchImpl(`${origin}/v1/phone/rooms/${roomId}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
      signal: AbortSignal.timeout(roomReadBudgetMs),
    }),
    'authenticated Room read',
  );
  const roomReadMs = now() - startedAt;
  if (roomReadMs >= roomReadBudgetMs)
    throw new Error(`authenticated Room read took ${roomReadMs}ms (budget ${roomReadBudgetMs}ms)`);
  if (room?.room?.id !== roomId || !Array.isArray(room.messages))
    throw new Error('authenticated Room read returned an invalid projection');

  return { health, roomId, roomReadMs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const result = await runServerReleaseSmoke({
    origin: process.env.SERVER_ORIGIN ?? 'https://server.usebeeline.app',
    expectedVersion: required('EXPECTED_RELEASE_VERSION'),
    expectedSha: required('EXPECTED_RELEASE_SHA'),
    reviewSecret: required('BEELINE_REVIEW_SECRET'),
  });
  console.log(
    `server smoke passed: Room ${result.roomId} read in ${result.roomReadMs}ms; pool=${JSON.stringify(result.health.database.pool)}`,
  );
}
