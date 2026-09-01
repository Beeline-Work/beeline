import type { IncomingMessage, ServerResponse } from 'node:http';
import { authTenantsFromEnvironment, oidcClientFromEnvironment } from '@beeline/auth/environment';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { verifyPhoneGitHubTicket } from '@beeline/auth/phone-github-ticket';
import { buildAuthServer } from '@beeline/auth/server';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import type { VerifyGitHubOidc } from './auth.js';
import type { SqlDatabase } from './database.js';
import { PhoneService } from './phone-service.js';

export interface MonolithAuthMount {
  handle(request: IncomingMessage, response: ServerResponse): void;
  verifyGitHubTicket: VerifyGitHubOidc;
  sealedGitHubUserToken(subject: string): Promise<string | undefined>;
  close(): Promise<void>;
}

export async function createMonolithAuth(
  database: SqlDatabase,
  publicOrigin: string,
  github:
    | {
        oauth: GitHubOAuthClient;
        app: GitHubAppClient;
        webhookSecret?: string;
        onWebhook?: (eventType: string, payload: unknown) => Promise<void>;
      }
    | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MonolithAuthMount> {
  const tenants = authTenantsFromEnvironment(env);
  const publicHost = new URL(publicOrigin).host.toLowerCase();
  const tenant = tenants.find((candidate) => candidate.host.toLowerCase() === publicHost);
  if (!tenant) {
    throw new Error(`BUZZY_AUTH_TENANTS_JSON must include monolith Host ${publicHost}`);
  }

  // Both schemas live in the monolith's one PostgreSQL database. AuthStore only
  // needs the same query/transaction contract and must not own or close the pool.
  const store = new AuthStore(database as unknown as TransactionalDatabase);
  await store.migrate();
  const pairing = new PhoneService(database, publicOrigin);
  const app = buildAuthServer({
    store,
    oidc: oidcClientFromEnvironment(env),
    ...(github ? { github } : {}),
    tenants,
    secureCookies: env.NODE_ENV === 'production',
    githubSetupToken: env.BUZZY_AUTH_SETUP_TOKEN,
    logger: false,
    claimAgentPairingCode: (input) => pairing.claimAgentConnectPairing(input),
  });
  await app.ready();

  return {
    handle: (request, response) => app.routing(request, response),
    verifyGitHubTicket: async (ticket) => {
      const result = await verifyPhoneGitHubTicket(store, tenant.community, ticket);
      if (result.status !== 'verified') throw new Error('GitHub identity exchange failed');
      return result.identity;
    },
    sealedGitHubUserToken: async (subject) => {
      if (await store.githubUserTokenStaleAt(tenant.community, subject)) return undefined;
      return (await store.githubUserToken(tenant.community, subject)) ?? undefined;
    },
    close: () => app.close(),
  };
}
