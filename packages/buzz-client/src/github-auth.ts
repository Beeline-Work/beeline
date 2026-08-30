import { nip98AuthHeader } from '@beeline/nostr';
import { authEndpoint, OidcBindError, requestAuthJson } from './auth-json.js';
import type { Identity } from './types.js';

const HEX_KEY_RE = /^[0-9a-f]{64}$/;

export interface GitHubRepositoryAccess {
  id: number;
  installationId: number;
  name: string;
  fullName: string;
  remote: string;
  defaultBranch: string;
}

export interface GitHubInstallationAccess {
  installationId: number;
  accountId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  accountAvatarUrl?: string;
  repositorySelection: 'all' | 'selected';
  status: 'active' | 'revoked' | 'suspended';
  repositoryCount: number;
  manageUrl: string;
}

export interface GitHubRepositoryAccessResult {
  accessible: boolean;
  installationId?: number;
  reason?: 'revoked' | 'not_granted';
  /**
   * The repository is NOT covered by the App and never was (distinct from a
   * move): only its owner can install the App, so the caller surfaces
   * `installUrl` as a shareable call to action instead of an error wall.
   */
  grantNeeded?: boolean;
  /** The App's state-less public install URL, present when `grantNeeded`. */
  installUrl?: string;
}

export interface GitHubRoomInstallationToken {
  token: string;
  expiresAt: string;
  installationId: number;
  fullName: string;
  /**
   * The Room binding author's CURRENT device key after key succession
   * (absent when the auth service has no succession ledger entry). A daemon
   * may treat a corner-scoped merge approval signed by this key as owner-signed.
   */
  authorizedBy?: string;
}

/** One stored GitHub repository-activity event, released to an authorized daemon. */
export interface GitHubRoomEvent {
  id: number;
  type: string;
  action: string;
  actor: string;
  summary: string;
  received_at: string;
  number?: number;
  title?: string;
  url?: string;
}

export interface GitHubRoomEventsResult {
  fullName: string;
  /** The newest stored id for the repository (0 when none). */
  head: number;
  /** Pass this back as `since` to continue from where this read ended. */
  cursor: number;
  events: GitHubRoomEvent[];
}

/** Begin the one-per-account Beeline GitHub App installation flow. */
export async function startGitHubInstallation(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  redirectUri: string,
  installationId?: number,
): Promise<string> {
  const { body, status } = await requestAuthJson(baseUrl, '/auth/github/install/start', {
    method: 'POST',
    identity,
    body: {
      pubkey: identity.publicKey,
      redirect_uri: redirectUri,
      ...(installationId === undefined ? {} : { installation_id: installationId }),
    },
  });
  if (typeof body.authorization_url !== 'string') {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid GitHub App URL',
      status,
    );
  }
  return body.authorization_url;
}

/** Repositories granted by the account's Beeline GitHub App installation. */
export async function listGitHubRepositories(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  options: { refresh?: boolean } = {},
): Promise<{
  installed: boolean;
  installations: GitHubInstallationAccess[];
  repositories: GitHubRepositoryAccess[];
}> {
  const url = authEndpoint(baseUrl, `/auth/github/repos/${identity.publicKey}`);
  if (options.refresh) url.searchParams.set('refresh', '1');
  const { body, status } = await requestAuthJson(baseUrl, url, { identity });
  if (
    typeof body.installed !== 'boolean' ||
    !Array.isArray(body.installations) ||
    !Array.isArray(body.repositories)
  ) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid GitHub repository list',
      status,
    );
  }
  const repositories = body.repositories.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new OidcBindError(
        'invalid_response',
        'auth service returned an invalid GitHub repository',
        status,
      );
    }
    const repo = entry as Record<string, unknown>;
    if (
      typeof repo.id !== 'number' ||
      typeof repo.installationId !== 'number' ||
      !Number.isSafeInteger(repo.installationId) ||
      typeof repo.name !== 'string' ||
      typeof repo.fullName !== 'string' ||
      typeof repo.remote !== 'string' ||
      typeof repo.defaultBranch !== 'string'
    ) {
      throw new OidcBindError(
        'invalid_response',
        'auth service returned an invalid GitHub repository',
        status,
      );
    }
    return repo as unknown as GitHubRepositoryAccess;
  });
  const installations = body.installations.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new OidcBindError(
        'invalid_response',
        'auth service returned an invalid GitHub installation',
        status,
      );
    }
    const installation = entry as Record<string, unknown>;
    if (
      typeof installation.installationId !== 'number' ||
      !Number.isSafeInteger(installation.installationId) ||
      typeof installation.accountId !== 'string' ||
      typeof installation.accountLogin !== 'string' ||
      (installation.accountType !== 'User' && installation.accountType !== 'Organization') ||
      (installation.repositorySelection !== 'all' &&
        installation.repositorySelection !== 'selected') ||
      (installation.status !== 'active' &&
        installation.status !== 'revoked' &&
        installation.status !== 'suspended') ||
      typeof installation.repositoryCount !== 'number' ||
      typeof installation.manageUrl !== 'string'
    ) {
      throw new OidcBindError(
        'invalid_response',
        'auth service returned an invalid GitHub installation',
        status,
      );
    }
    return installation as unknown as GitHubInstallationAccess;
  });
  return { installed: body.installed, installations, repositories };
}

export async function createGitHubRepository(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  input: { installationId: number; name: string; description?: string; private?: boolean },
): Promise<GitHubRepositoryAccess> {
  const { body, status } = await requestAuthJson(
    baseUrl,
    `/auth/github/repos/${identity.publicKey}`,
    {
      method: 'POST',
      identity,
      body: {
        installation_id: input.installationId,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.private !== undefined ? { private: input.private } : {}),
      },
    },
  );
  const repository = body.repository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid GitHub repository',
      status,
    );
  }
  return repository as unknown as GitHubRepositoryAccess;
}

export async function getGitHubRepositoryAccess(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  fullName: string,
): Promise<GitHubRepositoryAccessResult> {
  const url = authEndpoint(baseUrl, `/auth/github/repo-access/${identity.publicKey}`);
  url.searchParams.set('full_name', fullName);
  const { body, status } = await requestAuthJson(baseUrl, url, { identity });
  if (typeof body.accessible !== 'boolean') {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid repository access result',
      status,
    );
  }
  const installUrl = typeof body.install_url === 'string' ? body.install_url : undefined;
  return {
    ...(body as unknown as GitHubRepositoryAccessResult),
    ...(body.grant_needed === true ? { grantNeeded: true } : {}),
    ...(installUrl ? { installUrl } : {}),
  } as GitHubRepositoryAccessResult;
}

/**
 * Obtain an exact-repository installation token for a daemon that is a
 * current member of the Room. The auth sidecar re-resolves Room state; callers
 * cannot choose the repository or installation represented by the token.
 */
/** Options for {@link getGitHubRoomInstallationToken}. */
export interface GitHubRoomInstallationTokenOptions {
  /**
   * Ask the auth service to mint a READ-ONLY installation token: GitHub
   * receives `permissions: { contents: "read", metadata: "read" }` alongside
   * the pinned repository id, so the token is structurally incapable of
   * pushing or writing anything on any ref. This is the only variant a
   * session (Room or corner) may hold — push-capable credentials never leave
   * the daemon's own brokered paths (#376).
   */
  readOnly?: boolean;
}

export async function getGitHubRoomInstallationToken(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  roomId: string,
  options: GitHubRoomInstallationTokenOptions = {},
): Promise<GitHubRoomInstallationToken> {
  const relayQueryUrl = authEndpoint(baseUrl, '/query').toString();
  const { body, status } = await requestAuthJson(baseUrl, '/auth/github/room-token', {
    method: 'POST',
    identity,
    body: {
      pubkey: identity.publicKey,
      room_id: roomId,
      relay_authorizations: Array.from({ length: 16 }, () =>
        nip98AuthHeader(identity.secretKey, identity.publicKey, relayQueryUrl, 'POST'),
      ),
      ...(options.readOnly ? { read_only: true } : {}),
    },
  });
  if (
    typeof body.token !== 'string' ||
    !body.token ||
    typeof body.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(body.expires_at)) ||
    typeof body.installation_id !== 'number' ||
    !Number.isSafeInteger(body.installation_id) ||
    typeof body.full_name !== 'string' ||
    !/^[^/\s]+\/[^/\s]+$/.test(body.full_name) ||
    (body.authorized_by !== undefined &&
      (typeof body.authorized_by !== 'string' || !HEX_KEY_RE.test(body.authorized_by)))
  ) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid Room repository token',
      status,
    );
  }
  return {
    token: body.token,
    expiresAt: body.expires_at,
    installationId: body.installation_id,
    fullName: body.full_name,
    ...(typeof body.authorized_by === 'string' ? { authorizedBy: body.authorized_by } : {}),
  };
}

/**
 * Fetch stored GitHub repository activity for one Room, over the same
 * authority as {@link getGitHubRoomInstallationToken}: the auth sidecar
 * re-resolves Room state and releases only events for the repository that
 * Room is bound to. Omitting `since` bootstraps ("start from now"); passing a
 * previous result's `cursor` releases everything stored since, so a daemon
 * that was offline catches up instead of being silently skipped. `waitMs`
 * long-polls when there is nothing new yet.
 */
export async function getGitHubRoomEvents(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  roomId: string,
  options: { since?: number; waitMs?: number } = {},
): Promise<GitHubRoomEventsResult> {
  const relayQueryUrl = authEndpoint(baseUrl, '/query').toString();
  const { body, status } = await requestAuthJson(baseUrl, '/auth/github/room-events', {
    method: 'POST',
    identity,
    body: {
      pubkey: identity.publicKey,
      room_id: roomId,
      relay_authorizations: Array.from({ length: 16 }, () =>
        nip98AuthHeader(identity.secretKey, identity.publicKey, relayQueryUrl, 'POST'),
      ),
      ...(options.since !== undefined ? { since: options.since } : {}),
      ...(options.waitMs !== undefined ? { wait_ms: Math.round(options.waitMs) } : {}),
    },
  });
  if (
    typeof body.full_name !== 'string' ||
    !/^[^/\s]+\/[^/\s]+$/.test(body.full_name) ||
    typeof body.head !== 'number' ||
    !Number.isSafeInteger(body.head) ||
    typeof body.cursor !== 'number' ||
    !Number.isSafeInteger(body.cursor) ||
    !Array.isArray(body.events)
  ) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid Room event feed',
      status,
    );
  }
  return {
    fullName: body.full_name,
    head: body.head,
    cursor: body.cursor,
    events: body.events,
  } as unknown as GitHubRoomEventsResult;
}
