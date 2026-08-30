import type { AuthRouteContext } from './server-context.js';
export function registerServerNip05Routes(context: AuthRouteContext): void {
  const {
    app,
    options,
    now,
    tenantFor,
    noStore,
    managedIdentityJson,
    publicUrl,
    ProtocolError,
    isValidNip05Name,
    isResolvableNip05Name,
    verifyNip98Header,
  } = context;
  app.get('/.well-known/nostr.json', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const name = typeof query.name === 'string' ? query.name : null;
    const names: Record<string, string> = {};
    if (name && isResolvableNip05Name(name)) {
      const pubkey = await options.store.resolveNip05Name(name);
      if (pubkey) names[name] = pubkey;
    }
    reply.header('access-control-allow-origin', '*');
    return reply.type('application/json').send({ names });
  });

  app.post('/nip05/claim', async (request, reply) => {
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object') {
      throw new ProtocolError(400, 'invalid_request', 'expected claim request object');
    }
    const body = request.body as Record<string, unknown>;
    const name = body.name;
    if (typeof name !== 'string' || !isValidNip05Name(name)) {
      throw new ProtocolError(
        400,
        'invalid_name',
        'handle must be 3-30 lowercase letters, numbers, or dashes, and not reserved',
      );
    }
    const auth = verifyNip98Header(
      request.headers.authorization,
      publicUrl(tenant, request),
      'POST',
      now(),
    );
    if (!auth.ok) throw new ProtocolError(401, 'unauthorized', auth.reason);
    const authNow = now();
    const claimed = await options.store.claimNip98Event(
      auth.eventId,
      new Date(authNow.getTime() + 2 * 60_000),
      authNow,
    );
    if (!claimed)
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    const outcome = await options.store.claimNip05Name(
      tenant.community,
      name,
      auth.pubkey,
      authNow,
    );
    if (outcome.status === 'taken')
      throw new ProtocolError(409, 'name_taken', 'handle is already claimed');
    if (outcome.status === 'already_assigned')
      throw new ProtocolError(
        409,
        'handle_already_assigned',
        'this identity already has a hosted handle',
      );
    if (!('identity' in outcome)) throw new Error('unexpected hosted handle claim result');
    noStore(reply);
    return reply.status(outcome.status === 'claimed' ? 201 : 200).send({
      claimed: true,
      idempotent: outcome.status === 'idempotent',
      name,
      pubkey: auth.pubkey,
      identity: managedIdentityJson(outcome.identity),
    });
  });
}
