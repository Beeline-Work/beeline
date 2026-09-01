import { createHash, createHmac } from 'node:crypto';
import { generateKeypair, nip98AuthHeader, signEvent, type Keypair } from '@beeline/nostr';
import { describe, expect, it, vi } from 'vitest';
import { OIDC_BIND_KIND, OIDC_BIND_MARKER } from './protocol.js';
import {
  alphaTenant,
  app,
  betaTenant,
  bindEvent,
  bindGitHubIdentity,
  ceremony,
  database,
  githubState,
  provider,
  startCookie,
  state,
  store,
  type BindChallenge,
  useAuthServerFixture,
} from './server-test-fixture.js';

describe('GitHub installation, repositories, and token routes', () => {
  useAuthServerFixture();

  it('mints an exact-repository token only after Room authority accepts the agent', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '123',
        accountLogin: 'octocat',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 1,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'widget',
          fullName: 'octocat/widget',
          remote: 'https://github.com/octocat/widget.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    state.roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? {
            authorized: true,
            authorizedBy: owner.publicKey,
            fullName: 'octocat/widget',
            githubInstallationId: 77,
          }
        : { authorized: false, reason: 'agent_not_room_member' };
    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const relayAuthorizations = Array.from({ length: 16 }, () =>
      nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, url, 'POST'),
      },
      payload: {
        pubkey: agent.publicKey,
        room_id: 'room-1',
        relay_authorizations: relayAuthorizations,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: 'room-installation-token',
      installation_id: 77,
      full_name: 'octocat/widget',
    });
    expect(state.roomTokenMint).toEqual({ installationId: 77, repositoryIds: [42] });

    const refusalCases = [
      {
        reason: 'tenant_room_community_mismatch',
        response: {
          error: 'room_repository_unauthorized',
          message: 'agent is not authorized for this Room repository',
        },
      },
      {
        reason: 'agent_not_room_member',
        response: {
          error: 'room_membership_required',
          message: 'agent is not a member of this Room',
        },
      },
      {
        reason: 'room_repository_missing',
        response: {
          error: 'room_repository_unresolvable',
          message: 'Room repository could not be resolved',
        },
      },
      {
        reason: 'room_repository_remote_malformed',
        response: {
          error: 'room_repository_unresolvable',
          message: 'Room repository could not be resolved',
        },
      },
      {
        reason: 'room_repository_authority_missing',
        response: {
          error: 'room_repository_unauthorized',
          message: 'agent is not authorized for this Room repository',
        },
      },
    ] as const;

    for (const refusalCase of refusalCases) {
      state.roomTokenAuthority = async () => ({
        authorized: false,
        reason: refusalCase.reason,
      });
      const refusedAgent = generateKeypair();
      const refusedRoom = `private-${refusalCase.reason}`;
      const refused = await app.inject({
        method: 'POST',
        url: '/auth/github/room-token',
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(
            refusedAgent.secretKey,
            refusedAgent.publicKey,
            url,
            'POST',
          ),
        },
        payload: {
          pubkey: refusedAgent.publicKey,
          room_id: refusedRoom,
          relay_authorizations: Array.from({ length: 16 }, () =>
            nip98AuthHeader(
              refusedAgent.secretKey,
              refusedAgent.publicKey,
              `${alphaTenant.origin}/query`,
              'POST',
            ),
          ),
        },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual(refusalCase.response);
      expect(refused.body).not.toContain(refusedAgent.publicKey);
      expect(refused.body).not.toContain(refusedRoom);
    }

    const ungrantedAgent = generateKeypair();
    const ungrantedOwner = generateKeypair();
    state.roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: ungrantedOwner.publicKey,
      fullName: 'octocat/widget',
    });
    const ungranted = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          ungrantedAgent.secretKey,
          ungrantedAgent.publicKey,
          url,
          'POST',
        ),
      },
      payload: {
        pubkey: ungrantedAgent.publicKey,
        room_id: 'room-with-ungranted-repository',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(
            ungrantedAgent.secretKey,
            ungrantedAgent.publicKey,
            `${alphaTenant.origin}/query`,
            'POST',
          ),
        ),
      },
    });
    expect(ungranted.statusCode).toBe(403);
    expect(ungranted.json()).toEqual({
      error: 'owner_grant_needed',
      message:
        'octocat/widget is waiting for its owner to grant Beeline access. Ask the repository owner to install the Beeline GitHub App: https://github.test/apps/beeline/installations/new',
      install_url: 'https://github.test/apps/beeline/installations/new',
      repository: 'octocat/widget',
    });

    const refusalLogs = state.logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'GitHub Room token authority refused request');
    expect(refusalLogs.map((line) => line.authorityReason)).toEqual([
      ...refusalCases.map(({ reason }) => reason),
      'owner_grant_needed',
    ]);
    expect(refusalLogs.every((line) => line.agentPubkey && line.roomId)).toBe(true);
    expect(refusalLogs.at(-1)).toMatchObject({
      authorityReason: 'owner_grant_needed',
      authorizedBy: ungrantedOwner.publicKey,
      repository: 'octocat/widget',
    });
  });

  // Key succession: the binding was authored by a key that was later
  // replaced (device lost, identity recovered onto the successor). GitHub
  // installations exist for the SUCCESSOR key only; authority lookups run
  // against the resolved current key and the daemon learns it.
  it('honors successor-key requests against old-key-authored bindings', async () => {
    const agent = generateKeypair();
    const predecessorKey = 'a'.repeat(64);
    const successorKey = 'b'.repeat(64);
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: successorKey,
        authorizedSubject: 'owner-subject',
        accountId: '123',
        accountLogin: 'octocat',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 1,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'widget',
          fullName: 'octocat/widget',
          remote: 'https://github.com/octocat/widget.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    state.roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? {
            authorized: true,
            authorizedBy: predecessorKey,
            currentAuthorizedBy: successorKey,
            fullName: 'octocat/widget',
            githubInstallationId: 77,
          }
        : { authorized: false, reason: 'agent_not_room_member' };
    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, url, 'POST'),
      },
      payload: {
        pubkey: agent.publicKey,
        room_id: 'room-1',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      installation_id: 77,
      full_name: 'octocat/widget',
    });

    // An unrelated key resolving the same binding author is still refused:
    // no installation row exists under an unrelated identity.
    const unrelated = generateKeypair();
    state.roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === unrelated.publicKey && input.roomId === 'room-1'
        ? {
            authorized: true,
            authorizedBy: predecessorKey,
            currentAuthorizedBy: unrelated.publicKey,
            fullName: 'octocat/widget',
            githubInstallationId: 77,
          }
        : { authorized: false, reason: 'agent_not_room_member' };
    const refused = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(unrelated.secretKey, unrelated.publicKey, url, 'POST'),
      },
      payload: {
        pubkey: unrelated.publicKey,
        room_id: 'room-1',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(
            unrelated.secretKey,
            unrelated.publicKey,
            `${alphaTenant.origin}/query`,
            'POST',
          ),
        ),
      },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('never downgrades a Room installation token when a legacy request carries read_only', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '123',
        accountLogin: 'octocat',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 1,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'widget',
          fullName: 'octocat/widget',
          remote: 'https://github.com/octocat/widget.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    state.roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? {
            authorized: true,
            authorizedBy: owner.publicKey,
            fullName: 'octocat/widget',
            githubInstallationId: 77,
          }
        : { authorized: false, reason: 'agent_not_room_member' };
    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const mint = async (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/auth/github/room-token',
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, url, 'POST'),
        },
        payload: {
          pubkey: agent.publicKey,
          room_id: 'room-1',
          relay_authorizations: Array.from({ length: 16 }, () =>
            nip98AuthHeader(
              agent.secretKey,
              agent.publicKey,
              `${alphaTenant.origin}/query`,
              'POST',
            ),
          ),
          ...payload,
        },
      });

    // Legacy callers may still send read_only during a rolling deployment,
    // but the installation grant is no longer downgraded. Repository scope
    // stays pinned to the Room-bound repository.
    const readOnly = await mint({ read_only: true });
    expect(readOnly.statusCode).toBe(200);
    expect(state.roomTokenMint).toEqual({
      installationId: 77,
      repositoryIds: [42],
    });

  });

  it('completes an organization installation even when the user-token listing cannot verify it', async () => {
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'v'.repeat(43));
    // An unscoped OAuth lookup token cannot list organization installations;
    // production saw this surface as GET /user/installations failing outright.
    state.githubInstallationAccess = new Error('GitHub user installations failed: HTTP 404');

    const installStartUrl = 'https://alpha.example/auth/github/install/start';
    const installStart = await app.inject({
      method: 'POST',
      url: '/auth/github/install/start',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          installStartUrl,
          'POST',
        ),
      },
      payload: {
        pubkey: identity.publicKey,
        redirect_uri: 'beeline://buzz/github-installation',
      },
    });
    expect(installStart.statusCode).toBe(200);
    const installUrl = new URL(installStart.json().authorization_url);
    const installed = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?installation_id=78&setup_action=install&state=${installUrl.searchParams.get('state')}`,
      headers: { host: alphaTenant.host },
    });

    // The state-bound GitHub redirect from the installing org admin is the
    // authority; the unavailable listing is logged, never fatal.
    expect(installed.statusCode).toBe(302);
    expect(installed.headers.location).toBe('beeline://buzz/github-installation?installed=1');
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, identity.publicKey),
    ).resolves.toEqual([
      expect.objectContaining({
        installationId: 78,
        accountLogin: 'acme',
        accountType: 'Organization',
        status: 'active',
      }),
    ]);
    const warnings = state.logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (line) =>
          line.msg === 'GitHub installation listing unavailable for organization verification',
      );
    expect(warnings).toHaveLength(1);
  });

  it('logs unexpected installation-callback failures with their request id instead of a silent 500', async () => {
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'v'.repeat(43));
    state.githubRepositoryListError = new Error(
      'GitHub installation repositories failed: HTTP 502',
    );

    const installStartUrl = 'https://alpha.example/auth/github/install/start';
    const installStart = await app.inject({
      method: 'POST',
      url: '/auth/github/install/start',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          installStartUrl,
          'POST',
        ),
      },
      payload: {
        pubkey: identity.publicKey,
        redirect_uri: 'beeline://buzz/github-installation',
      },
    });
    const installUrl = new URL(installStart.json().authorization_url);
    const installed = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?installation_id=77&setup_action=install&state=${installUrl.searchParams.get('state')}`,
      headers: { host: alphaTenant.host },
    });

    expect(installed.statusCode).toBe(500);
    const body = installed.json() as Record<string, unknown>;
    expect(body.error).toBe('internal_error');
    expect(String(body.message)).toContain('GitHub installation repositories failed: HTTP 502');
    expect(typeof body.reqId).toBe('string');
    expect(String(body.message)).toContain(String(body.reqId));
    const logged = state.logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.reqId === body.reqId && line.level === 50);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).toContain('HTTP 502');
  });

  it('answers a stateless (share-link/marketplace) install return with a friendly landing and no side effects', async () => {
    // A foreign install carries installation_id/setup_action but NO state
    // marker minted by an in-app flow. The install itself succeeded on
    // GitHub's side; the return must be a human-readable confirmation, never
    // raw JSON, and must bind no session and mint no token.
    const response = await app.inject({
      method: 'GET',
      url: '/auth/github/callback?installation_id=77&setup_action=install',
      headers: { host: alphaTenant.host },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('GitHub connected');
    expect(response.body).not.toContain('"error"');
    // Purely informational: no session binding, no token minting, no flow
    // cookie, no installation persisted under any identity.
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(state.roomTokenMint).toBeUndefined();
    await expect(store.githubInstallation(alphaTenant.community, 77)).resolves.toBeNull();
  });

  it('answers a stateless install return on the legacy alias routes too', async () => {
    const installed = await app.inject({
      method: 'GET',
      url: '/auth/github/installed?installation_id=77&setup_action=install',
      headers: { host: alphaTenant.host },
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.headers['content-type']).toContain('text/html');
    expect(installed.body).toContain('GitHub connected');

    const viaCallbackAlias = await app.inject({
      method: 'GET',
      url: '/auth/github/install/callback?installation_id=90&setup_action=install',
      headers: { host: alphaTenant.host },
    });
    expect(viaCallbackAlias.statusCode).toBe(200);
    expect(viaCallbackAlias.body).toContain('GitHub connected');
  });

  it('answers a present-but-invalid install state with a readable error page, not raw JSON', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/github/callback?installation_id=77&setup_action=install&state=wrongstate',
      headers: { host: alphaTenant.host },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('connection link');
    expect(response.body).not.toContain('invalid_request');
    expect(() => JSON.parse(response.body)).toThrow();
    // Still no session or token side effects on the failed path.
    expect(state.roomTokenMint).toBeUndefined();
    await expect(store.githubInstallation(alphaTenant.community, 77)).resolves.toBeNull();
  });

  it('re-mints Room tokens for a repository that transferred after its Room binding was written', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    // History of one transferred repository: the personal installation listed
    // it under the old owner/name, then the transfer moved the same immutable
    // id to the org installation and it disappeared from the old one.
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '123',
        accountLogin: 'lunchboxfortwo',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'beeline',
          fullName: 'lunchboxfortwo/beeline',
          remote: 'https://github.com/lunchboxfortwo/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '456',
        accountLogin: 'Beeline-Work',
        accountType: 'Organization',
        installationId: 90,
        repositorySelection: 'all',
        status: 'active',
        repositoryCount: 1,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      90,
      [
        {
          id: 42,
          installationId: 90,
          name: 'beeline',
          fullName: 'Beeline-Work/beeline',
          remote: 'https://github.com/Beeline-Work/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    // The transfer removed the repository from the personal installation.
    await store.replaceGitHubRepositories(alphaTenant.community, 77, [], new Date());
    state.roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? { authorized: true, authorizedBy: owner.publicKey, fullName: 'lunchboxfortwo/beeline' }
        : { authorized: false, reason: 'agent_not_room_member' };
    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const relayAuthorizations = Array.from({ length: 16 }, () =>
      nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, url, 'POST'),
      },
      payload: {
        pubkey: agent.publicKey,
        room_id: 'room-1',
        relay_authorizations: relayAuthorizations,
      },
    });

    // The stale binding self-heals onto the transferred repo's current name.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: 'room-installation-token',
      installation_id: 90,
      full_name: 'Beeline-Work/beeline',
    });
    expect(state.roomTokenMint).toEqual({ installationId: 90, repositoryIds: [42] });
  });

  it("follows GitHub's rename redirect once, persists it, and names the uncovered destination", async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '456',
        accountLogin: 'Beeline-Work',
        accountType: 'Organization',
        installationId: 91,
        repositorySelection: 'all',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    state.roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: owner.publicKey,
      fullName: 'lunchboxfortwo/beeline',
    });
    state.githubRepositoryLookup = { id: 42, fullName: 'Beeline-Work/beeline' };
    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const injectRoomToken = async (pubkey: Keypair) =>
      app.inject({
        method: 'POST',
        url: '/auth/github/room-token',
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(pubkey.secretKey, pubkey.publicKey, url, 'POST'),
        },
        payload: {
          pubkey: pubkey.publicKey,
          room_id: 'room-1',
          relay_authorizations: Array.from({ length: 16 }, () =>
            nip98AuthHeader(
              pubkey.secretKey,
              pubkey.publicKey,
              `${alphaTenant.origin}/query`,
              'POST',
            ),
          ),
        },
      });

    // The new location exists but no installation covers it: say exactly that.
    const uncovered = await injectRoomToken(agent);
    expect(uncovered.statusCode).toBe(403);
    expect(uncovered.json()).toEqual({
      error: 'repository_not_granted',
      message: 'repository moved to Beeline-Work/beeline; grant the App access there',
    });

    // The org install lands and grants the new location: the same request now
    // resolves through the redirect AND persists the learned alias.
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      91,
      [
        {
          id: 42,
          installationId: 91,
          name: 'beeline',
          fullName: 'Beeline-Work/beeline',
          remote: 'https://github.com/Beeline-Work/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    const healed = await injectRoomToken(agent);
    expect(healed.statusCode).toBe(200);
    expect(healed.json()).toMatchObject({ full_name: 'Beeline-Work/beeline' });

    // The alias is durable: with GitHub's redirect gone entirely, the old
    // binding still resolves without any lookup.
    state.githubRepositoryLookup = undefined;
    const viaAlias = await injectRoomToken(agent);
    expect(viaAlias.statusCode).toBe(200);
    expect(viaAlias.json()).toMatchObject({ full_name: 'Beeline-Work/beeline' });
  });

  it('reconciles an unrecorded installation when a transfer refuses under a stale active install', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await bindGitHubIdentity(owner, 'p'.repeat(43));
    // Production shape (2026-08): the personal installation is still recorded
    // ACTIVE against the OLD owner, but the repository has transferred away
    // from it — its snapshot rows are deactivated, not deleted.
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: '123',
        accountId: '123',
        accountLogin: 'lunchboxfortwo',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'beeline',
          fullName: 'lunchboxfortwo/beeline',
          remote: 'https://github.com/lunchboxfortwo/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    await store.replaceGitHubRepositories(alphaTenant.community, 77, [], new Date());
    // Meanwhile the org installation exists on GitHub but was never recorded,
    // and the private repository's rename redirect is invisible to the App
    // JWT alone — so movedTo stays empty and the refusal reads plain
    // not_granted.
    state.githubRepositoryLookup = undefined;
    state.githubAppInstallations = [90];
    state.githubAppInstallationDetail = [
      { installationId: 90, accountId: '789', login: 'Beeline-Work', type: 'Organization' },
    ];
    state.githubAppRepositoryDetail = {
      90: [{ id: 42, name: 'beeline', fullName: 'Beeline-Work/beeline' }],
    };
    // The user-token listing cannot verify organization installs (#355).
    state.githubUserInstallations = new Error('GitHub user installations failed: HTTP 404');
    state.roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? { authorized: true, authorizedBy: owner.publicKey, fullName: 'lunchboxfortwo/beeline' }
        : { authorized: false, reason: 'agent_not_room_member' };

    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          agent.secretKey,
          agent.publicKey,
          `${alphaTenant.origin}/auth/github/room-token`,
          'POST',
        ),
      },
      payload: {
        pubkey: agent.publicKey,
        room_id: 'room-1',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
      },
    });

    // Reconcile records the org install, then immutable-id healing resolves
    // the stale binding onto the transferred repository under its new name.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: 'room-installation-token',
      installation_id: 90,
      full_name: 'Beeline-Work/beeline',
    });
    expect(state.roomTokenMint).toEqual({ installationId: 90, repositoryIds: [42] });
  });

  it('heals a Room binding pinned to the old installation when a transfer moves the repo to a reconciled org installation behind a stale user token', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await bindGitHubIdentity(owner, 'r'.repeat(43));
    // Production shape (2026-08, live trace): the personal installation is
    // still recorded ACTIVE against the old owner, its snapshot rows for the
    // transferred repository are deactivated, and the Room binding on the
    // relay pins THAT OLD installation id. The org installation was never
    // recorded, and the owner's STORED OAuth user token is stale — every
    // user-token listing answers HTTP 401.
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: '123',
        accountId: '123',
        accountLogin: 'lunchboxfortwo',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'beeline',
          fullName: 'lunchboxfortwo/beeline',
          remote: 'https://github.com/lunchboxfortwo/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    await store.replaceGitHubRepositories(alphaTenant.community, 77, [], new Date());
    state.githubRepositoryLookup = undefined;
    state.githubAppInstallations = [90];
    state.githubAppInstallationDetail = [
      { installationId: 90, accountId: '789', login: 'Beeline-Work', type: 'Organization' },
    ];
    state.githubAppRepositoryDetail = {
      90: [{ id: 42, name: 'beeline', fullName: 'Beeline-Work/beeline' }],
    };
    state.githubUserInstallations = new Error('GitHub user installations failed: HTTP 401');
    state.roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? {
            authorized: true,
            authorizedBy: owner.publicKey,
            fullName: 'lunchboxfortwo/beeline',
            // The relay's room-config binding still names the OLD install.
            githubInstallationId: 77,
          }
        : { authorized: false, reason: 'agent_not_room_member' };

    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, url, 'POST'),
      },
      payload: {
        pubkey: agent.publicKey,
        room_id: 'room-1',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
      },
    });

    // The unavailable listing proceeds for the Organization account (#359),
    // reconcile claims the org install, and immutable-id healing resolves the
    // stale binding onto the transferred repository under its new name — the
    // binding's old installation pin is a hint from bind time, never a veto.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token: 'room-installation-token',
      installation_id: 90,
      full_name: 'Beeline-Work/beeline',
    });
    expect(state.roomTokenMint).toEqual({ installationId: 90, repositoryIds: [42] });
  });

  it('still refuses a discovered organization installation when the user-token listing definitively denies it', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await bindGitHubIdentity(owner, 's'.repeat(43));
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: '123',
        accountId: '123',
        accountLogin: 'lunchboxfortwo',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    state.githubRepositoryLookup = undefined;
    state.githubAppInstallations = [90];
    state.githubAppInstallationDetail = [
      { installationId: 90, accountId: '789', login: 'Beeline-Work', type: 'Organization' },
    ];
    state.githubUserInstallations = [77];
    state.roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? { authorized: true, authorizedBy: owner.publicKey, fullName: 'acme/widget' }
        : { authorized: false, reason: 'agent_not_room_member' };

    const url = `${alphaTenant.origin}/auth/github/room-token`;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(agent.secretKey, agent.publicKey, url, 'POST'),
      },
      payload: {
        pubkey: agent.publicKey,
        room_id: 'room-1',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(agent.secretKey, agent.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
      },
    });

    // A SUCCESSFUL listing that does not contain the installation is a
    // definitive negative: the claim is refused and nothing is recorded.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: 'owner_grant_needed',
      message: expect.stringContaining('is waiting for its owner to grant Beeline access'),
      install_url: 'https://github.test/apps/beeline/installations/new',
      repository: expect.any(String),
    });
    await expect(store.githubInstallation(alphaTenant.community, 90)).resolves.toBeNull();
  });

  it('marks the stored user token stale when GitHub rejects it and clears that on a fresh bind', async () => {
    const owner = generateKeypair();
    await bindGitHubIdentity(owner, 't'.repeat(43));
    state.githubRepositoryLookup = undefined;
    state.githubAppInstallations = [90];
    state.githubAppInstallationDetail = [
      { installationId: 90, accountId: '789', login: 'Beeline-Work', type: 'Organization' },
    ];
    state.githubUserInstallations = new Error('GitHub user installations failed: HTTP 401');

    const reposUrl = `https://alpha.example/auth/github/repos/${owner.publicKey}`;
    const injectRepos = async () =>
      app.inject({
        method: 'GET',
        url: `/auth/github/repos/${owner.publicKey}`,
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(owner.secretKey, owner.publicKey, reposUrl, 'GET'),
        },
      });

    // First request triggers reconcile; its stale-marking is fire-and-forget,
    // so let the microtask land before reading the response surface.
    await injectRepos();
    await new Promise((resolve) => setImmediate(resolve));
    const marked = await injectRepos();
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({ installed: true, user_token_stale: true });

    // A fresh OAuth bind replaces the credential and the staleness clears.
    await store.saveGitHubUserToken(alphaTenant.community, '123', 'sealed', new Date());
    const refreshed = await injectRepos();
    expect(refreshed.json()).toMatchObject({ installed: true });
    expect((refreshed.json() as Record<string, unknown>).user_token_stale).toBeUndefined();
  }, 20000);

  it('rate-limits the failing-path reconciliation so repeated refusals cannot storm GitHub', async () => {
    const owner = generateKeypair();
    const agent = generateKeypair();
    await bindGitHubIdentity(owner, 'q'.repeat(43));
    // Same stale-active-install shape, but GitHub holds NO undiscovered
    // installation: every request still refuses, and the App-JWT enumeration
    // must run exactly once per rate-limit window.
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: '123',
        accountId: '123',
        accountLogin: 'lunchboxfortwo',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'selected',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'beeline',
          fullName: 'lunchboxfortwo/beeline',
          remote: 'https://github.com/lunchboxfortwo/beeline.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    await store.replaceGitHubRepositories(alphaTenant.community, 77, [], new Date());
    state.githubRepositoryLookup = undefined;
    state.roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === agent.publicKey && input.roomId === 'room-1'
        ? { authorized: true, authorizedBy: owner.publicKey, fullName: 'lunchboxfortwo/beeline' }
        : { authorized: false, reason: 'agent_not_room_member' };
    const injectRoomToken = () =>
      app.inject({
        method: 'POST',
        url: '/auth/github/room-token',
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(
            agent.secretKey,
            agent.publicKey,
            `${alphaTenant.origin}/auth/github/room-token`,
            'POST',
          ),
        },
        payload: {
          pubkey: agent.publicKey,
          room_id: 'room-1',
          relay_authorizations: Array.from({ length: 16 }, () =>
            nip98AuthHeader(
              agent.secretKey,
              agent.publicKey,
              `${alphaTenant.origin}/query`,
              'POST',
            ),
          ),
        },
      });

    const first = await injectRoomToken();
    expect(first.statusCode).toBe(403);
    expect(first.json()).toMatchObject({ error: 'owner_grant_needed' });
    const second = await injectRoomToken();
    expect(second.statusCode).toBe(403);
    expect(state.githubInstallationListCalls).toBe(1);
    const refusalLogs = state.logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'GitHub Room token authority refused request');
    expect(refusalLogs.length).toBe(2);
    expect(refusalLogs.every((line) => line.authorityReason === 'owner_grant_needed')).toBe(true);
    // No GitHub credential material ever reaches the log.
    expect(state.logLines.join('\n')).not.toMatch(/Bearer ey|PRIVATE KEY|github-user-token/);
  });

  it('completes GitHub sign-in with a direct redirect to the installed app', async () => {
    const appState = 'g'.repeat(43);
    const redirectUri = 'beeline://buzz/github-callback';
    const start = await app.inject({
      method: 'GET',
      url: `/auth/github/start?app_redirect=${encodeURIComponent(redirectUri)}&app_state=${appState}`,
      headers: { host: alphaTenant.host },
    });
    expect(start.statusCode).toBe(302);

    const callback = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=github-code&state=${githubState}`,
      headers: { host: alphaTenant.host, cookie: startCookie(start.headers['set-cookie']) },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers['cache-control']).toBe('no-store');
    const completion = new URL(String(callback.headers.location));
    expect(`${completion.protocol}//${completion.host}${completion.pathname}`).toBe(redirectUri);
    expect(completion.searchParams.get('state')).toBe(appState);
    expect(completion.searchParams.get('ticket')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(completion.searchParams.get('provider')).toBe('https://github.com');
  });

  it('serves the legacy GitHub mobile callback as a human app handoff, never a 404', async () => {
    const appState = 'h'.repeat(43);
    const associatedRedirect = `${alphaTenant.origin}/auth/github/mobile-callback`;
    const start = await app.inject({
      method: 'GET',
      url: `/auth/github/start?app_redirect=${encodeURIComponent(associatedRedirect)}&app_state=${appState}`,
      headers: { host: alphaTenant.host },
    });
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=github-code&state=${githubState}`,
      headers: { host: alphaTenant.host, cookie: startCookie(start.headers['set-cookie']) },
    });
    const completion = new URL(callback.headers.location!);
    const handoff = await app.inject({
      method: 'GET',
      url: `${completion.pathname}${completion.search}`,
      headers: { host: alphaTenant.host },
    });

    expect(handoff.statusCode).toBe(200);
    expect(handoff.headers['content-type']).toContain('text/html');
    expect(handoff.body).toContain('Return to Beeline');
    expect(handoff.body).toContain('beeline://buzz/github-callback?state=');
    expect(handoff.body).toContain(`state=${appState}`);
    expect(handoff.body).not.toContain('Route GET:');

    const installationHandoff = await app.inject({
      method: 'GET',
      url: '/auth/github/mobile-callback?installed=1',
      headers: { host: alphaTenant.host },
    });
    expect(installationHandoff.statusCode).toBe(200);
    expect(installationHandoff.body).toContain('beeline://buzz/github-installation?installed=1');
  });

  it('reconciles a missed GitHub installation callback onto the current identity after pubkey churn', async () => {
    state.githubAppInstallations = [77];
    state.githubUserInstallations = [77];
    const oldIdentity = generateKeypair();
    await bindGitHubIdentity(oldIdentity, 'o'.repeat(43));
    await database.query(
      `DELETE FROM beeline_identity_links
       WHERE community = $1 AND issuer = 'https://github.com' AND subject = $2`,
      [alphaTenant.community, '123'],
    );
    const currentIdentity = generateKeypair();
    await bindGitHubIdentity(currentIdentity, 'n'.repeat(43));

    const reposUrl = `https://alpha.example/auth/github/repos/${currentIdentity.publicKey}`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${currentIdentity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          currentIdentity.secretKey,
          currentIdentity.publicKey,
          reposUrl,
          'GET',
        ),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      installed: true,
      installations: [{ installationId: 77, accountId: '123' }],
      repositories: [{ installationId: 77, fullName: 'octocat/widget' }],
    });
    expect(state.githubInstallationListCalls).toBe(1);
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, oldIdentity.publicKey),
    ).resolves.toEqual([]);
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, currentIdentity.publicKey),
    ).resolves.toEqual([
      expect.objectContaining({
        installationId: 77,
        authorizedSubject: '123',
        accountId: '123',
      }),
    ]);
  });

  it('moves an orphaned installation row only when the stable GitHub subject matches', async () => {
    state.githubAppInstallations = [77];
    const oldIdentity = generateKeypair();
    await bindGitHubIdentity(oldIdentity, '3'.repeat(43));
    await expect(
      store.saveGitHubInstallation(
        {
          community: alphaTenant.community,
          pubkey: oldIdentity.publicKey,
          authorizedSubject: '123',
          accountId: '123',
          accountLogin: 'octocat',
          accountType: 'User',
          installationId: 77,
          repositorySelection: 'all',
          status: 'active',
          repositoryCount: 0,
        },
        new Date(),
      ),
    ).resolves.toBe(true);
    await database.query(
      `DELETE FROM beeline_identity_links
       WHERE community = $1 AND issuer = 'https://github.com' AND subject = $2`,
      [alphaTenant.community, '123'],
    );
    const currentIdentity = generateKeypair();
    await bindGitHubIdentity(currentIdentity, '4'.repeat(43));

    const reposUrl = `https://alpha.example/auth/github/repos/${currentIdentity.publicKey}`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${currentIdentity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          currentIdentity.secretKey,
          currentIdentity.publicKey,
          reposUrl,
          'GET',
        ),
      },
    });

    expect(response.json()).toMatchObject({
      installed: true,
      installations: [{ installationId: 77 }],
      repositories: [{ fullName: 'octocat/widget' }],
    });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, oldIdentity.publicKey),
    ).resolves.toEqual([]);
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, currentIdentity.publicKey),
    ).resolves.toEqual([expect.objectContaining({ installationId: 77, authorizedSubject: '123' })]);
  });

  it('returns the honest cached miss when GitHub installation reconciliation fails', async () => {
    state.githubAppInstallations = new Error('GitHub rate limited');
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'f'.repeat(43));

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ installed: false, installations: [], repositories: [] });
    expect(state.githubInstallationListCalls).toBe(1);

    const throttledUrl = `${reposUrl}?retry=1`;
    const throttled = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}?retry=1`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, throttledUrl, 'GET'),
      },
    });
    expect(throttled.statusCode).toBe(200);
    expect(throttled.json()).toEqual({ installed: false, installations: [], repositories: [] });
    expect(state.githubInstallationListCalls).toBe(1);
    // No GitHub credential material ever reaches the log — the reconcile
    // path signs App JWTs and decrypts user tokens internally.
    expect(state.logLines.join('\n')).not.toMatch(/Bearer ey|PRIVATE KEY|github-user-token/);
  });

  it('keeps users with no GitHub App installation in the install flow', async () => {
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'z'.repeat(43));

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ installed: false, installations: [], repositories: [] });
    expect(state.githubInstallationListCalls).toBe(1);
  });

  it('does not claim repository access when GitHub repository verification fails', async () => {
    state.githubAppInstallations = [77];
    state.githubUserInstallations = [77];
    state.githubRepositoryListError = new Error('repository listing failed');
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'v'.repeat(43));

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ installed: false, installations: [], repositories: [] });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, identity.publicKey),
    ).resolves.toEqual([]);
  });

  it('does not transfer an organization installation between distinct GitHub subjects', async () => {
    state.githubAppInstallations = [78];
    state.githubUserInstallations = [78];
    const firstIdentity = generateKeypair();
    await bindGitHubIdentity(firstIdentity, '1'.repeat(43));
    const firstReposUrl = `https://alpha.example/auth/github/repos/${firstIdentity.publicKey}`;
    const firstResponse = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${firstIdentity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          firstIdentity.secretKey,
          firstIdentity.publicKey,
          firstReposUrl,
          'GET',
        ),
      },
    });
    expect(firstResponse.json()).toMatchObject({
      installed: true,
      installations: [{ installationId: 78 }],
    });

    state.githubSubject = '999';
    state.githubLogin = 'hubot';
    state.githubDisplayName = 'Hubot';
    const secondIdentity = generateKeypair();
    await bindGitHubIdentity(secondIdentity, '2'.repeat(43));
    const secondReposUrl = `https://alpha.example/auth/github/repos/${secondIdentity.publicKey}`;
    const secondResponse = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${secondIdentity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          secondIdentity.secretKey,
          secondIdentity.publicKey,
          secondReposUrl,
          'GET',
        ),
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual({
      installed: false,
      installations: [],
      repositories: [],
    });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, firstIdentity.publicKey),
    ).resolves.toEqual([expect.objectContaining({ installationId: 78, authorizedSubject: '123' })]);
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, secondIdentity.publicKey),
    ).resolves.toEqual([]);
  });

  it('discovers an unrecorded organization installation on refresh and grants its repositories', async () => {
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'r'.repeat(43));
    // The App is installed on org acme but the callback never persisted, and
    // an unscoped OAuth token cannot even list organization installations.
    // Only the App JWT enumeration can discover it.
    state.githubAppInstallations = [78];
    state.githubUserInstallations = new Error('GitHub user installations failed: HTTP 404');

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}?refresh=1`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}?refresh=1`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      installed: true,
      installations: [
        { installationId: 78, accountLogin: 'acme', accountType: 'Organization', status: 'active' },
      ],
      repositories: [{ installationId: 78, fullName: 'acme/widget' }],
    });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, identity.publicKey),
    ).resolves.toEqual([
      expect.objectContaining({ installationId: 78, authorizedSubject: '123', status: 'active' }),
    ]);

    // The discovered installation now grants Room tokens with no callback.
    state.roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: identity.publicKey,
      fullName: 'acme/widget',
    });
    state.roomTokenMint = undefined;
    const tokenUrl = 'https://alpha.example/auth/github/room-token';
    const minted = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, tokenUrl, 'POST'),
      },
      payload: {
        pubkey: identity.publicKey,
        room_id: 'org-room',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(
            identity.secretKey,
            identity.publicKey,
            `${alphaTenant.origin}/query`,
            'POST',
          ),
        ),
      },
    });
    expect(minted.statusCode).toBe(200);
    expect(minted.json()).toMatchObject({ installation_id: 78, full_name: 'acme/widget' });
    expect(state.roomTokenMint).toMatchObject({ installationId: 78, repositoryIds: [42] });
  });

  it('heals a missed installation during a room-token refusal instead of refusing a covered repository', async () => {
    const owner = generateKeypair();
    await bindGitHubIdentity(owner, 'h'.repeat(43));
    state.githubAppInstallations = [78];
    state.githubUserInstallations = [78];
    state.roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: owner.publicKey,
      fullName: 'acme/widget',
    });
    state.roomTokenMint = undefined;
    const tokenUrl = 'https://alpha.example/auth/github/room-token';
    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(owner.secretKey, owner.publicKey, tokenUrl, 'POST'),
      },
      payload: {
        pubkey: owner.publicKey,
        room_id: 'org-room',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(owner.secretKey, owner.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ installation_id: 78, full_name: 'acme/widget' });
    expect(state.roomTokenMint).toMatchObject({ installationId: 78 });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, owner.publicKey),
    ).resolves.toEqual([expect.objectContaining({ installationId: 78, status: 'active' })]);
  });

  it('still refuses a room token when reconciliation finds no covering installation', async () => {
    const owner = generateKeypair();
    await bindGitHubIdentity(owner, 'm'.repeat(43));
    state.roomTokenAuthority = async () => ({
      authorized: true,
      authorizedBy: owner.publicKey,
      fullName: 'octocat/widget',
    });
    const tokenUrl = 'https://alpha.example/auth/github/room-token';
    const response = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(owner.secretKey, owner.publicKey, tokenUrl, 'POST'),
      },
      payload: {
        pubkey: owner.publicKey,
        room_id: 'uncovered-room',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(owner.secretKey, owner.publicKey, `${alphaTenant.origin}/query`, 'POST'),
        ),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'owner_grant_needed' });
    expect(state.githubInstallationListCalls).toBe(1);
  });

  it('answers a never-granted repository with the typed owner-grant state and records the pending link', async () => {
    const requester = generateKeypair();
    await bindGitHubIdentity(requester, 'g'.repeat(43));
    // The requester administers the Room and authors the binding, but the
    // repository's OWNER has never installed the App — only the owner can.
    state.roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === requester.publicKey && input.roomId === 'room-foreign'
        ? { authorized: true, authorizedBy: requester.publicKey, fullName: 'bananaman/widget' }
        : { authorized: false, reason: 'agent_not_room_member' };
    const tokenUrl = `${alphaTenant.origin}/auth/github/room-token`;
    const refused = await app.inject({
      method: 'POST',
      url: '/auth/github/room-token',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(requester.secretKey, requester.publicKey, tokenUrl, 'POST'),
      },
      payload: {
        pubkey: requester.publicKey,
        room_id: 'room-foreign',
        relay_authorizations: Array.from({ length: 16 }, () =>
          nip98AuthHeader(
            requester.secretKey,
            requester.publicKey,
            `${alphaTenant.origin}/query`,
            'POST',
          ),
        ),
      },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({
      error: 'owner_grant_needed',
      message:
        'bananaman/widget is waiting for its owner to grant Beeline access. Ask the repository owner to install the Beeline GitHub App: https://github.test/apps/beeline/installations/new',
      install_url: 'https://github.test/apps/beeline/installations/new',
      repository: 'bananaman/widget',
    });

    // The bind-time probe surfaces the same typed state (with Room context so
    // the pending link is recorded here too) — a pending state, not an error.
    const accessUrl = `${alphaTenant.origin}/auth/github/repo-access/${requester.publicKey}?full_name=bananaman%2Fwidget&room_id=room-foreign`;
    const probe = await app.inject({
      method: 'GET',
      url: `/auth/github/repo-access/${requester.publicKey}?full_name=bananaman%2Fwidget&room_id=room-foreign`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(requester.secretKey, requester.publicKey, accessUrl, 'GET'),
      },
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({
      accessible: false,
      grant_needed: true,
      install_url: 'https://github.test/apps/beeline/installations/new',
    });
  });

  it('flips a pending Room link active when the owner installs, announcing it once', async () => {
    const requester = generateKeypair();
    const owner = generateKeypair();
    await bindGitHubIdentity(requester, 'h'.repeat(43));
    state.roomTokenAuthority = async (_tenant, input) =>
      input.agentPubkey === requester.publicKey && input.roomId === 'room-pending'
        ? { authorized: true, authorizedBy: requester.publicKey, fullName: 'octocat/widget' }
        : { authorized: false, reason: 'agent_not_room_member' };
    const tokenUrl = `${alphaTenant.origin}/auth/github/room-token`;
    const injectRefusal = () =>
      app.inject({
        method: 'POST',
        url: '/auth/github/room-token',
        headers: {
          host: alphaTenant.host,
          authorization: nip98AuthHeader(
            requester.secretKey,
            requester.publicKey,
            tokenUrl,
            'POST',
          ),
        },
        payload: {
          pubkey: requester.publicKey,
          room_id: 'room-pending',
          relay_authorizations: Array.from({ length: 16 }, () =>
            nip98AuthHeader(
              requester.secretKey,
              requester.publicKey,
              `${alphaTenant.origin}/query`,
              'POST',
            ),
          ),
        },
      });
    expect((await injectRefusal()).statusCode).toBe(403);

    // The repository OWNER installs the App on their own account later. The
    // installation webhook records coverage under the community...
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: owner.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '123',
        accountLogin: 'octocat',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'all',
        status: 'active',
        repositoryCount: 0,
      },
      new Date(),
    );
    const addedPayload = JSON.stringify({
      action: 'added',
      installation: { id: 77 },
      repositories_added: [
        {
          id: 42,
          name: 'widget',
          full_name: 'octocat/widget',
          clone_url: 'https://github.com/octocat/widget.git',
          default_branch: 'main',
        },
      ],
      repositories_removed: [],
    });
    const webhook = await app.inject({
      method: 'POST',
      url: '/auth/github/webhook',
      headers: {
        host: alphaTenant.host,
        'content-type': 'application/json',
        'x-github-event': 'installation_repositories',
        'x-github-delivery': 'delivery-grant-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'webhook-secret').update(addedPayload).digest('hex')}`,
      },
      payload: addedPayload,
    });
    expect(webhook.statusCode).toBe(202);

    // ...and the pending link flips active with exactly one feed announcement.
    // A duplicate grant (redelivery or reconcile) is idempotent.
    const announcements = await store.githubRepoEvents('octocat/widget', 0, 100);
    expect(announcements.filter((event) => event.eventType === 'beeline_room_link')).toHaveLength(
      1,
    );
    expect(announcements.at(-1)).toMatchObject({
      eventType: 'beeline_room_link',
      summary: 'Beeline access granted: octocat/widget is now linked.',
    });
    await store.activateGitHubRoomLinks(alphaTenant.community, ['octocat/widget'], new Date());
    const stillOne = await store.githubRepoEvents('octocat/widget', 0, 100);
    expect(stillOne.filter((event) => event.eventType === 'beeline_room_link')).toHaveLength(1);

    // Once the grant is claimable by the community (the install callback or
    // reconcile records the installation against a linked human — the
    // requester here), the SAME room-token request succeeds with no re-entry.
    await store.saveGitHubInstallation(
      {
        community: alphaTenant.community,
        pubkey: requester.publicKey,
        authorizedSubject: 'owner-subject',
        accountId: '123',
        accountLogin: 'octocat',
        accountType: 'User',
        installationId: 77,
        repositorySelection: 'all',
        status: 'active',
        repositoryCount: 1,
      },
      new Date(),
    );
    await store.replaceGitHubRepositories(
      alphaTenant.community,
      77,
      [
        {
          id: 42,
          installationId: 77,
          name: 'widget',
          fullName: 'octocat/widget',
          remote: 'https://github.com/octocat/widget.git',
          defaultBranch: 'main',
        },
      ],
      new Date(),
    );
    const granted = await injectRefusal();
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({ full_name: 'octocat/widget' });
  });

  it('does not claim a newly discovered user-owned installation the user cannot administer', async () => {
    const identity = generateKeypair();
    await bindGitHubIdentity(identity, 'u'.repeat(43));
    // The App serves installation 77 elsewhere; this user's listing succeeds
    // but does not include it, so reconciliation must not claim it for them.
    state.githubAppInstallations = [77];
    state.githubUserInstallations = [];

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}?refresh=1`;
    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}?refresh=1`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ installed: false, installations: [], repositories: [] });
    await expect(
      store.githubInstallationsForPubkey(alphaTenant.community, identity.publicKey),
    ).resolves.toEqual([]);
  });

  it('groups multiple installations, applies repository webhooks, and preserves revoked bindings', async () => {
    const identity = generateKeypair();
    const appState = 'a'.repeat(43);
    const start = await app.inject({
      method: 'GET',
      url: `/auth/github/start?app_redirect=${encodeURIComponent('https://alpha.example/auth/github/mobile-callback')}&app_state=${appState}`,
      headers: { host: alphaTenant.host },
    });
    expect(start.statusCode).toBe(302);
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=github-code&state=${githubState}`,
      headers: { host: alphaTenant.host, cookie: startCookie(start.headers['set-cookie']) },
    });
    expect(callback.statusCode).toBe(302);
    const completion = new URL(callback.headers.location!);
    const challenge = Object.fromEntries(completion.searchParams) as unknown as BindChallenge;
    for (const key of ['protocol', 'kind', 'issued_at', 'expires_at'] as const) {
      (challenge as unknown as Record<string, unknown>)[key] = Number(
        completion.searchParams.get(key),
      );
    }
    const bind = await app.inject({
      method: 'POST',
      url: '/auth/oidc/bind',
      headers: { host: alphaTenant.host },
      payload: { ticket: challenge.ticket, event: bindEvent(challenge, identity) },
    });
    expect(bind.statusCode).toBe(201);

    const installStartUrl = 'https://alpha.example/auth/github/install/start';
    const installStart = await app.inject({
      method: 'POST',
      url: '/auth/github/install/start',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          installStartUrl,
          'POST',
        ),
      },
      payload: {
        pubkey: identity.publicKey,
        redirect_uri: 'beeline://buzz/github-installation',
      },
    });
    expect(installStart.statusCode).toBe(200);
    const installUrl = new URL(installStart.json().authorization_url);
    const installed = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?installation_id=77&setup_action=install&state=${installUrl.searchParams.get('state')}`,
      headers: { host: alphaTenant.host },
    });
    expect(installed.statusCode).toBe(302);
    expect(installed.headers.location).toBe('beeline://buzz/github-installation?installed=1');

    const manageStartUrl = 'https://alpha.example/auth/github/install/start?intent=manage';
    const manageStart = await app.inject({
      method: 'POST',
      url: '/auth/github/install/start?intent=manage',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          manageStartUrl,
          'POST',
        ),
      },
      payload: {
        pubkey: identity.publicKey,
        redirect_uri: 'beeline://buzz/github-installation',
        installation_id: 77,
      },
    });
    expect(manageStart.statusCode).toBe(200);
    const manageUrl = new URL(manageStart.json().authorization_url);
    expect(manageUrl.origin + manageUrl.pathname).toBe(
      'https://github.com/settings/installations/77',
    );
    expect(manageUrl.searchParams.get('state')).toHaveLength(43);

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const secondStart = await app.inject({
      method: 'POST',
      url: '/auth/github/install/start',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          installStartUrl,
          'POST',
        ),
      },
      payload: {
        pubkey: identity.publicKey,
        redirect_uri: 'https://alpha.example/auth/github/mobile-callback',
      },
    });
    const secondUrl = new URL(secondStart.json().authorization_url);
    const secondInstalled = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?installation_id=78&setup_action=update&state=${secondUrl.searchParams.get('state')}`,
      headers: { host: alphaTenant.host },
    });
    expect(secondInstalled.statusCode).toBe(302);

    const reposUrl = `https://alpha.example/auth/github/repos/${identity.publicKey}`;
    const repos = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, reposUrl, 'GET'),
      },
    });
    expect(repos.statusCode).toBe(200);
    expect(repos.json()).toMatchObject({
      installed: true,
      installations: [
        { installationId: 78, accountLogin: 'acme', repositoryCount: 1 },
        { installationId: 77, accountLogin: 'octocat', repositoryCount: 1 },
      ],
      repositories: [
        { installationId: 78, fullName: 'acme/widget' },
        { installationId: 77, fullName: 'octocat/widget' },
      ],
    });

    const refreshReposUrl = `${reposUrl}?refresh=1`;
    const refreshedRepos = await app.inject({
      method: 'GET',
      url: `/auth/github/repos/${identity.publicKey}?refresh=1`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          refreshReposUrl,
          'GET',
        ),
      },
    });
    expect(refreshedRepos.statusCode).toBe(200);
    expect(refreshedRepos.json().repositories).toHaveLength(2);

    const repositoryPayload = JSON.stringify({
      action: 'removed',
      installation: { id: 77 },
      repositories_added: [
        {
          id: 43,
          name: 'fresh',
          full_name: 'octocat/fresh',
          clone_url: 'https://github.com/octocat/fresh.git',
          default_branch: 'trunk',
        },
      ],
      repositories_removed: [{ id: 42, full_name: 'octocat/widget' }],
    });
    const webhook = await app.inject({
      method: 'POST',
      url: '/auth/github/webhook',
      headers: {
        host: alphaTenant.host,
        'content-type': 'application/json',
        'x-github-event': 'installation_repositories',
        'x-github-delivery': 'delivery-repositories-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'webhook-secret').update(repositoryPayload).digest('hex')}`,
      },
      payload: repositoryPayload,
    });
    expect(webhook.statusCode).toBe(202);
    const duplicateWebhook = await app.inject({
      method: 'POST',
      url: '/auth/github/webhook',
      headers: {
        host: alphaTenant.host,
        'content-type': 'application/json',
        'x-github-event': 'installation_repositories',
        'x-github-delivery': 'delivery-repositories-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'webhook-secret').update(repositoryPayload).digest('hex')}`,
      },
      payload: repositoryPayload,
    });
    expect(duplicateWebhook.json()).toMatchObject({ accepted: true, duplicate: true });
    expect(
      await store.githubRepositoriesForPubkey(alphaTenant.community, identity.publicKey),
    ).toEqual([
      expect.objectContaining({ installationId: 78, fullName: 'acme/widget' }),
      expect.objectContaining({ installationId: 77, fullName: 'octocat/fresh' }),
    ]);

    const deletedPayload = JSON.stringify({ action: 'deleted', installation: { id: 77 } });
    const deleted = await app.inject({
      method: 'POST',
      url: '/auth/github/webhook',
      headers: {
        host: alphaTenant.host,
        'content-type': 'application/json',
        'x-github-event': 'installation',
        'x-github-delivery': 'delivery-installation-2',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'webhook-secret').update(deletedPayload).digest('hex')}`,
      },
      payload: deletedPayload,
    });
    expect(deleted.statusCode).toBe(202);
    await expect(
      store.githubRepositoryAccess(alphaTenant.community, identity.publicKey, 'octocat/widget'),
    ).resolves.toMatchObject({ accessible: false, installationId: 77, reason: 'revoked' });
  });
});
