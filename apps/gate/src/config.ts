/**
 * Connection config for the Phase-0 merge-gate proof.
 *
 * The relay is the isolated stack in `relay-stack/` (Buzz `ghcr.io/block/buzz:main`).
 * `HOST` is the authority the relay resolved its deployment community under
 * (see the "Deployment community ensured" startup log). Every request must
 * carry this exact Host header, and every NIP-98 `u` tag must use it verbatim,
 * or the relay's host-binding / `u`-match fails closed before it checks the key.
 */
export const HOST = process.env.BUZZY_RELAY_HOST ?? '127.0.0.1:3010';

/** HTTP scheme. The relay derives NIP-98 `u`-scheme from its `ws://` relay_url => http. */
export const SCHEME = process.env.BUZZY_RELAY_SCHEME ?? 'http';

/** Base URL for the relay HTTP bridge (`/events`, `/query`) and git transport. */
export const BASE_URL = `${SCHEME}://${HOST}`;

/** Repo-root git URL for `{owner}/{repo}` (no service suffix). */
export function gitRepoUrl(ownerHex: string, repo: string): string {
  return `${BASE_URL}/git/${ownerHex}/${repo}`;
}
