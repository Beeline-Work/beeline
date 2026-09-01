import { randomBytes } from 'node:crypto';
import { isReasonableAgentName } from '@beeline/buzz-client';
import { generateKeypair } from '@beeline/nostr';
import type { AuthRouteContext } from './server-context.js';

const DEVICE_TTL_MS = 10 * 60_000;
const SUPPORTED_HARNESSES = new Set(['codex', 'claude', 'goose', 'pi', 'grok']);
const PROVIDER_REQUIRED = new Set(['goose', 'pi']);
const SUPPORTED_PROVIDERS = new Set(['openrouter', 'openai', 'anthropic', 'google', 'xai']);
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function pairingPart(): string {
  const bytes = randomBytes(4);
  return [...bytes].map((value) => PAIRING_ALPHABET[value % PAIRING_ALPHABET.length]).join('');
}

function pairingCode(): string {
  return `BUZZ-${pairingPart()}-${pairingPart()}`;
}

function userCode(): string {
  return `BEE-${pairingPart()}-${pairingPart()}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function connectPage(input: {
  heading: string;
  detail: string;
  userCode?: string;
  button?: boolean;
}): string {
  const action = input.userCode
    ? `/auth/github/start?device_user_code=${encodeURIComponent(input.userCode)}`
    : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Beeline — Connect agent</title>
    <style>
      :root { color-scheme: dark; }
      body { background:#090909; color:#f4efe5; font:16px system-ui,sans-serif; margin:0; }
      main { box-sizing:border-box; margin:0 auto; max-width:34rem; padding:18vh 1.5rem 3rem; }
      .mark { color:#c2933c; font-weight:800; letter-spacing:.11em; text-transform:uppercase; }
      h1 { font-size:clamp(1.8rem,5vw,2.7rem); line-height:1.08; margin:.75rem 0; }
      p { color:#c9c2b6; line-height:1.6; }
      button { background:#c2933c; border:0; border-radius:.65rem; color:#14100a; cursor:pointer;
        font:inherit; font-weight:800; margin-top:1.2rem; padding:.9rem 1.15rem; width:100%; }
      code { color:#e2bd71; }
    </style>
  </head>
  <body><main>
    <div class="mark">Beeline</div>
    <h1>${escapeHtml(input.heading)}</h1>
    <p>${escapeHtml(input.detail)}</p>
    ${input.userCode ? `<p>Connection <code>${escapeHtml(input.userCode)}</code></p>` : ''}
    ${input.button ? `<form method="get" action="${action}"><button type="submit">Connect this agent</button></form>` : ''}
  </main></body>
</html>`;
}

export function agentConnectApprovedPage(): string {
  return connectPage({
    heading: 'Agent connected',
    detail: 'You can close this tab and say hi in the app.',
  });
}

export function registerServerAgentConnectRoutes(context: AuthRouteContext): void {
  const {
    app,
    options,
    now,
    tenantFor,
    noStore,
    ProtocolError,
    randomToken,
    sha256,
    encryptGitHubToken,
    decryptGitHubToken,
  } = context;

  app.post('/auth/device/connect', async (request, reply) => {
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object') {
      throw new ProtocolError(400, 'invalid_request', 'expected device connection request');
    }
    const body = request.body as Record<string, unknown>;
    const harness = typeof body.harness === 'string' ? body.harness.trim().toLowerCase() : '';
    const provider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
    const model = typeof body.model === 'string' ? body.model.trim().slice(0, 200) : '';
    const soul = typeof body.soul === 'string' ? body.soul.trim().slice(0, 1_000) : '';
    const agentName =
      typeof body.agent_name === 'string' ? body.agent_name.trim().replace(/\s+/g, ' ') : '';
    const codeChallenge =
      typeof body.code_challenge === 'string' ? body.code_challenge.toLowerCase() : '';
    if (!SUPPORTED_HARNESSES.has(harness)) {
      throw new ProtocolError(400, 'invalid_harness', 'unsupported agent harness');
    }
    if (PROVIDER_REQUIRED.has(harness) && !SUPPORTED_PROVIDERS.has(provider)) {
      throw new ProtocolError(400, 'invalid_provider', 'this harness requires a provider');
    }
    if (!PROVIDER_REQUIRED.has(harness) && provider) {
      throw new ProtocolError(400, 'invalid_provider', 'this harness supplies its own provider');
    }
    if (
      !model ||
      !soul ||
      !agentName ||
      !isReasonableAgentName(agentName) ||
      !/^[0-9a-f]{64}$/.test(codeChallenge)
    ) {
      throw new ProtocolError(
        400,
        'invalid_request',
        'agent name, model, soul, and PKCE challenge are required',
      );
    }
    const issuedAt = now();
    const deviceCode = randomToken();
    const readableCode = userCode();
    await options.store.createAgentConnectDevice({
      deviceCodeHash: sha256(deviceCode),
      userCode: readableCode,
      codeChallenge,
      tenantCommunity: tenant.community,
      harness,
      ...(provider ? { provider } : {}),
      model,
      soul,
      agentName,
      createdAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + DEVICE_TTL_MS),
    });
    noStore(reply);
    return reply.status(201).send({
      device_code: deviceCode,
      user_code: readableCode,
      verification_uri: `${tenant.origin}/auth/device/connect`,
      verification_uri_complete: `${tenant.origin}/auth/device/connect?user_code=${encodeURIComponent(readableCode)}`,
      expires_in: Math.floor(DEVICE_TTL_MS / 1_000),
      interval: 2,
    });
  });

  app.get('/auth/device/connect', async (request, reply) => {
    tenantFor(request);
    const query = request.query as Record<string, unknown>;
    const readableCode = typeof query.user_code === 'string' ? query.user_code.toUpperCase() : '';
    const device = readableCode
      ? await options.store.findAgentConnectDeviceByUserCode(readableCode)
      : null;
    noStore(reply);
    reply.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    );
    if (!device || device.expiresAt.getTime() < now().getTime()) {
      return reply
        .status(404)
        .type('text/html; charset=utf-8')
        .send(
          connectPage({
            heading: 'Connection expired',
            detail: 'Return to the terminal and run the connect command again.',
          }),
        );
    }
    if (device.approvedAt) {
      return reply.type('text/html; charset=utf-8').send(
        connectPage({
          heading: 'Agent connected',
          detail: 'You can close this tab and say hi in the app.',
        }),
      );
    }
    return reply.redirect(
      `/auth/github/start?device_user_code=${encodeURIComponent(readableCode)}`,
      302,
    );
  });

  app.post('/auth/device/token', async (request, reply) => {
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object') {
      throw new ProtocolError(400, 'invalid_request', 'expected device token request');
    }
    const body = request.body as Record<string, unknown>;
    const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
    const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
    if (!deviceCode || !verifier) {
      throw new ProtocolError(400, 'invalid_request', 'device code and verifier are required');
    }
    const deviceCodeHash = sha256(deviceCode);
    const device = await options.store.findAgentConnectDevice(deviceCodeHash);
    if (!device || device.tenantCommunity !== tenant.community) {
      throw new ProtocolError(404, 'unknown_device', 'device connection not found');
    }
    if (device.codeChallenge !== sha256(verifier)) {
      throw new ProtocolError(401, 'invalid_verifier', 'device verifier did not match');
    }
    if (device.expiresAt.getTime() < now().getTime()) {
      throw new ProtocolError(410, 'expired_token', 'device connection expired');
    }
    if (device.consumedAt) {
      throw new ProtocolError(409, 'token_used', 'device credentials were already delivered');
    }
    if (!device.approvedAt) {
      noStore(reply);
      return reply.status(428).send({ error: 'authorization_pending' });
    }
    const consumed = await options.store.consumeAgentConnectDevice(deviceCodeHash, now());
    if (!consumed?.sealedCredentials || !consumed.workspaceId || !consumed.pairedBy) {
      throw new ProtocolError(409, 'token_used', 'device credentials were already delivered');
    }
    const credentials = JSON.parse(decryptGitHubToken(consumed.sealedCredentials)) as Record<
      string,
      unknown
    >;
    noStore(reply);
    return reply.send({
      ...credentials,
      workspace_id: consumed.workspaceId,
      workspace_name: credentials.workspace_name,
      paired_by: consumed.pairedBy,
      agent_pubkey: consumed.agentPubkey,
      agent_name: consumed.agentName,
      harness: consumed.harness,
      ...(consumed.provider ? { provider: consumed.provider } : {}),
      model: consumed.model,
      soul: consumed.soul,
    });
  });

  // The GitHub callback completes approval after the existing OAuth/session
  // flow proves the human account. This helper is called from that callback.
  context.setAgentConnectApproval(async (tenant, flow, identity) => {
    if (!flow.deviceCodeHash) return false;
    const link = await options.store.identityLinkForSubject(
      tenant.community,
      identity.issuer,
      identity.audience,
      identity.subject,
    );
    if (!link) {
      throw new ProtocolError(
        403,
        'beeline_sign_in_required',
        'sign in to Beeline in the app before connecting an agent',
      );
    }
    const workspace = await options.store.latestWorkspaceForMember(
      link.pubkey,
      tenant.roomCommunityIds,
    );
    if (!workspace) {
      throw new ProtocolError(404, 'workspace_not_found', 'no active Beeline Workspace was found');
    }
    const device = await options.store.findAgentConnectDevice(flow.deviceCodeHash);
    if (!device || device.tenantCommunity !== tenant.community) {
      throw new ProtocolError(404, 'unknown_device', 'device connection not found');
    }
    const agent = generateKeypair();
    const bodyIdentity = generateKeypair();
    const code = pairingCode();
    const approved = await options.store.approveAgentConnectDevice({
      deviceCodeHash: flow.deviceCodeHash,
      workspaceId: workspace.workspaceId,
      pairedBy: link.pubkey,
      agentPubkey: agent.publicKey,
      pairingTokenHash: sha256(code),
      sealedCredentials: encryptGitHubToken(
        JSON.stringify({
          pairing_code: code,
          agent_secret_key: Buffer.from(agent.secretKey).toString('hex'),
          agent_pubkey: agent.publicKey,
          body_secret_key: Buffer.from(bodyIdentity.secretKey).toString('hex'),
          workspace_name: workspace.name,
        }),
      ),
      now: now(),
    });
    if (!approved) {
      throw new ProtocolError(409, 'already_approved', 'device connection was already approved');
    }
    return true;
  });
}
