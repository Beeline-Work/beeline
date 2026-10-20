import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { readMaestroRoom } from './maestro-room.mjs';

test('Maestro reads an existing Room over authenticated monolith HTTP without fixture writes', async () => {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
    });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/auth/review/exchange') {
      assert.deepEqual(JSON.parse(body), { secret: 'fixture-review-proof' });
      response.end(JSON.stringify({ accessToken: 'fixture-access-proof' }));
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer fixture-access-proof');
    const payloads = {
      '/v1/phone/workspaces': { workspaces: [{ id: 'workspace-1' }] },
      '/v1/phone/workspaces/workspace-1/chats': { chats: [{ room: { id: 'room-1' } }] },
      '/v1/phone/rooms/room-1': { room: { id: 'room-1' }, messages: [] },
    };
    response.end(JSON.stringify(payloads[request.url]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const roomId = await readMaestroRoom({
      origin: `http://127.0.0.1:${server.address().port}`,
      reviewSecret: 'fixture-review-proof',
    });
    assert.equal(roomId, 'room-1');
    assert.deepEqual(
      calls.map(({ method, path }) => [method, path]),
      [
        ['POST', '/v1/auth/review/exchange'],
        ['GET', '/v1/phone/workspaces'],
        ['GET', '/v1/phone/workspaces/workspace-1/chats'],
        ['GET', '/v1/phone/rooms/room-1'],
      ],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Maestro fails visibly when the review identity has no Room', async () => {
  await assert.rejects(
    readMaestroRoom({
      origin: 'https://example.test',
      reviewSecret: 'fixture',
      fetchImpl: async (url) =>
        Response.json(url.endsWith('/exchange') ? { accessToken: 'fixture' } : { workspaces: [] }),
    }),
    /Review identity has no Room/,
  );
});
