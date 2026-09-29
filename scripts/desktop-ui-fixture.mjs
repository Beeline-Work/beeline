import http from 'node:http';

// Synthetic, loopback-only phone reads for desktop visual smoke runs. The
// workflow seeds the matching preview Keychain identity on its disposable VM.
const identityId = 'a'.repeat(64);
const identity = { pubkey: identityId, kind: 'human', name: 'Fixture Tester' };
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Fixture Workspace',
  role: 'owner',
  updatedAt: 1,
};
const roomId = '22222222-2222-4222-8222-222222222222';
const chats = {
  workspace,
  viewer: identity,
  chats: [
    {
      room: { id: roomId, workspaceId: workspace.id, name: 'Fixture Room' },
      unread: false,
    },
  ],
  truncated: false,
  watchFilters: [{ '#h': [roomId] }],
};

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

const server = http.createServer((request, response) => {
  if (request.url === '/health') return json(response, 200, { ok: true });
  if (request.url === '/v1/auth/refresh' && request.method === 'POST') {
    return json(response, 200, {
      accessToken: 'fixture-access',
      accessExpiresAt: Date.now() + 60 * 60 * 1000,
      refreshToken: 'fixture-refresh',
      refreshExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
      identityId,
    });
  }
  if (request.headers.authorization !== 'Bearer fixture-access') {
    return json(response, 401, { error: 'unauthorized' });
  }
  if (request.url === '/v1/phone/workspaces') {
    return json(response, 200, {
      workspaces: [workspace],
      viewer: identity,
      truncated: false,
      watchFilters: [],
    });
  }
  if (request.url === `/v1/phone/workspaces/${workspace.id}/chats`) {
    return json(response, 200, chats);
  }
  return json(response, 404, { error: 'fixture_route_not_found' });
});

server.listen(39191, '127.0.0.1');
