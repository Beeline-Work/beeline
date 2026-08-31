/**
 * `beeline corner-git-credential` — the git credential-helper backend the
 * daemon wires into GitHub-backed corner sessions.
 *
 * git invokes this with the credential protocol on stdin (`get` + key=value
 * lines). It answers with a fresh repository-scoped GitHub App installation
 * token. Authority is exactly the daemon's own room-token path (agent must be
 * a current member of the Room bound to that repo); the session never names a
 * repository.
 */
import {
  getGitHubRoomInstallationToken,
  type GitHubRoomInstallationToken,
  type Identity,
} from '@beeline/buzz-client';
import { findAgentRuntimeConfigPaths, readRuntimeRecord, runtimeIdentity } from './runtime.js';

export interface CornerGitCredentialDeps {
  env?: NodeJS.ProcessEnv;
  loadRuntimeForRoom?: (
    roomId: string,
  ) => Promise<{ relayBaseUrl: string; identity: Identity } | undefined>;
  fetchToken?: (
    relayBaseUrl: string,
    identity: Pick<Identity, 'secretKey' | 'publicKey'>,
    roomId: string,
  ) => Promise<GitHubRoomInstallationToken>;
}

/**
 * Resolve the stored runtime record whose Room list names `roomId`. A host may
 * hold several paired agents; the helper must mint through the identity of the
 * daemon that actually serves this session's parent Room.
 */
export async function loadRuntimeForRoom(
  roomId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ relayBaseUrl: string; identity: Identity } | undefined> {
  const configPaths = await findAgentRuntimeConfigPaths(env);
  for (const configPath of configPaths) {
    const runtime = await readRuntimeRecord(configPath).catch(() => undefined);
    if (!runtime) continue;
    if (!runtime.rooms.some((room) => room.channelId === roomId)) continue;
    return { relayBaseUrl: runtime.relayBaseUrl, identity: runtimeIdentity(runtime.agent) };
  }
  return undefined;
}

export async function runCornerGitCredentialCommand(
  args: string[],
  deps: CornerGitCredentialDeps = {},
): Promise<number> {
  const roomFlag = args.indexOf('--room');
  const configFlag = args.indexOf('--config');
  const roomId = roomFlag >= 0 ? args[roomFlag + 1] : undefined;
  const configPath = configFlag >= 0 ? args[configFlag + 1] : undefined;
  if (!roomId || !configPath) {
    console.error(
      '[body] corner-git-credential requires --config <runtime.json> --room <channelId>',
    );
    return 2;
  }
  // Drain the credential-protocol request from stdin; the answer does not
  // depend on it (the repo is derived from Room truth server-side), but a
  // helper that never reads can make git's write fail with EPIPE.
  await new Promise<void>((resolveDrain) => {
    process.stdin.resume();
    process.stdin.on('data', () => undefined);
    process.stdin.on('end', () => resolveDrain());
    process.stdin.on('error', () => resolveDrain());
    setTimeout(resolveDrain, 2_000).unref?.();
  });

  try {
    const resolved =
      (await deps.loadRuntimeForRoom?.(roomId)) ??
      (await loadRuntimeForRoomViaConfig(configPath, roomId));
    if (!resolved) {
      console.error(`[body] no paired agent runtime serves Room ${roomId}`);
      return 1;
    }
    const granted =
      (await deps.fetchToken?.(resolved.relayBaseUrl, resolved.identity, roomId)) ??
      (await getGitHubRoomInstallationToken(resolved.relayBaseUrl, resolved.identity, roomId));
    process.stdout.write('username=x-access-token\n');
    process.stdout.write(`password=${granted.token}\n`);
    return 0;
  } catch (error) {
    // Plain language only: this lands in the agent's tool output. Never echo
    // token material or raw relay/auth internals.
    console.error(
      '[body] repository token unavailable:',
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
}

/**
 * The `--config` argument is authoritative when given: it pins the exact
 * runtime record the daemon baked into the helper script, so no discovery is
 * needed inside the sandbox. Falls back to host-wide discovery when the record
 * cannot be read (e.g. relocated after an update).
 */
async function loadRuntimeForRoomViaConfig(
  configPath: string,
  roomId: string,
): Promise<{ relayBaseUrl: string; identity: Identity } | undefined> {
  const runtime = await readRuntimeRecord(configPath).catch(() => undefined);
  if (runtime?.rooms.some((room) => room.channelId === roomId)) {
    return { relayBaseUrl: runtime.relayBaseUrl, identity: runtimeIdentity(runtime.agent) };
  }
  return loadRuntimeForRoom(roomId);
}
