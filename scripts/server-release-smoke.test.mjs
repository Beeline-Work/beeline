import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { runServerReleaseSmoke } from './server-release-smoke.mjs';

test('waits through a slow boot and then proves an authenticated Room read', async (t) => {
  let healthAttempts = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') {
      healthAttempts += 1;
      if (healthAttempts < 4) {
        response.writeHead(503).end('{"ok":false}');
        return;
      }
      response.end(
        JSON.stringify({
          ok: true,
          database: {
            pool: { size: 5, inUse: 1, waiting: 0 },
            oldestActiveQueryAgeMs: 42,
          },
        }),
      );
      return;
    }
    if (request.url === '/version') response.end('{"version":"v1.2.3","sourceSha":"abc"}');
    else if (request.url === '/v1/auth/review/exchange')
      response.end('{"accessToken":"phone_test"}');
    else if (request.url === '/v1/phone/workspaces')
      response.end('{"workspaces":[{"id":"workspace"}]}');
    else if (request.url === '/v1/phone/workspaces/workspace/chats')
      response.end('{"chats":[{"room":{"id":"room"}}]}');
    else if (request.url === '/v1/phone/rooms/room')
      response.end('{"room":{"id":"room"},"messages":[]}');
    else response.writeHead(404).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const result = await runServerReleaseSmoke({
    origin: `http://127.0.0.1:${port}`,
    expectedVersion: 'v1.2.3',
    expectedSha: 'abc',
    reviewSecret: 'review-secret',
    bootBudgetMs: 2_000,
    pollIntervalMs: 5,
  });

  assert.equal(healthAttempts, 4);
  assert.equal(result.roomId, 'room');
  assert.ok(result.roomReadMs < 2_000);
});
