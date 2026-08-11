import { DEFAULT_RELAY_HOST, DEFAULT_RELAY_SCHEME } from '@beeline/buzz-client';

export interface RelayConfig {
  host: string;
  scheme: string;
  baseUrl: string;
}

/** Resolve the relay authority while retaining explicit local/custom overrides. */
export function resolveRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const host = env.BUZZY_RELAY_HOST ?? DEFAULT_RELAY_HOST;
  const scheme = env.BUZZY_RELAY_SCHEME ?? DEFAULT_RELAY_SCHEME;
  return { host, scheme, baseUrl: `${scheme}://${host}` };
}

const relay = resolveRelayConfig();

export const HOST = relay.host;
export const SCHEME = relay.scheme;

/** Base URL for the relay HTTP bridge (`/events`, `/query`) and git transport. */
export const BASE_URL = relay.baseUrl;

/** Repo-root git URL for `{owner}/{repo}` (no service suffix). */
export function gitRepoUrl(ownerHex: string, repo: string): string {
  return `${BASE_URL}/git/${ownerHex}/${repo}`;
}
