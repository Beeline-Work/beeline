import { observeFunnelAuth } from './signin-funnel.js';
import { recordSigninAttempt } from './signin-attempts.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authTenantsFromEnvironment, oidcClientFromEnvironment } from '@beeline/auth/environment';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { verifyPhoneGitHubTicket } from '@beeline/auth/phone-github-ticket';
import { createHash } from 'node:crypto';
import { buildAuthServer } from '@beeline/auth/server';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import type { VerifyGitHubOidc, VerifyGoogleOidc } from './auth.js';
import type { SqlDatabase } from './database.js';
import { PhoneService } from './phone-service.js';
import type { TokenAuth } from './auth.js';

export interface MonolithAuthMount {
  handle(request: IncomingMessage, response: ServerResponse): void;
  verifyGitHubTicket: VerifyGitHubOidc;
  verifyGoogleTicket: VerifyGoogleOidc;
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
      }
    | undefined,
  options: {
    createDaemonExchange: TokenAuth['createDaemonExchange'];
    completeRepositoryInstallation?: (state: string, installationId?: number, code?: string, callbackUri?: string) => Promise<string>;
    env?: NodeJS.ProcessEnv;
    webAppOrigins?: readonly string[];
  },
): Promise<MonolithAuthMount> {
  const env = options.env ?? process.env;
  const tenants = authTenantsFromEnvironment(env);
  const publicHost = new URL(publicOrigin).host.toLowerCase();
  const tenant = tenants.find((candidate) => candidate.host.toLowerCase() === publicHost);
  if (!tenant) {
    throw new Error(
      `BEELINE_AUTH_TENANTS_JSON must include monolith Host ${publicHost}`,
    );
  }

  // Both schemas live in the monolith's one PostgreSQL database. AuthStore only
  // needs the same query/transaction contract and must not own or close the pool.
  // Its migrations run once in migrate-cli before any Machine is updated.
  const store = new AuthStore(database as unknown as TransactionalDatabase);
  const pairing = new PhoneService(database, publicOrigin);
  const app = buildAuthServer({
    store,
    onFunnelAuth: (input) => observeFunnelAuth(database, input),
    onSigninAttempt: (input) => recordSigninAttempt(database, input),
    completeRepositoryInstallation: options.completeRepositoryInstallation,
    oidc: oidcClientFromEnvironment(env),
    ...(github ? { github } : {}),
    tenants,
    secureCookies: env.NODE_ENV === 'production',
    webAppOrigins: options.webAppOrigins,
    nativeRedirectUris: ['google', 'github'].map(provider => new URL(`/mcp/oauth/callback/${provider}`, publicOrigin).toString()),
    githubSetupToken: env.BEELINE_AUTH_SETUP_TOKEN,
    logger: false,
    claimAgentPairingCode: async (input) => {
      return pairing.claimAgentConnectPairing(input, (agentId, transaction) =>
        options.createDaemonExchange(agentId, transaction),
      );
    },
    renameConnectedAgent: (input) => pairing.renameConnectedAgent(input),
    finishAgentConnectPairing: (input) => pairing.finishAgentConnectPairing(input),
  });
  await app.ready();

  return {
    handle: (request, response) => {
      if (new URL(request.url ?? '/', publicOrigin).pathname === '/auth/github/webhook') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"error":"not_found"}\n');
        return;
      }
      app.routing(request, response);
    },
    verifyGoogleTicket: async (ticket) => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('invalid Google ticket');
      const hash = createHash('sha256').update(ticket).digest('hex');
      const result = await store.consumeTicketForPhone(
        hash,
        tenant.community,
        new Date(),
        'https://accounts.google.com',
      );
      if (result.status !== 'exchanged') throw new Error('Google identity exchange failed');
      return {
        subject: result.ticket.subject,
        email: result.ticket.providerLogin ?? undefined,
        name: result.ticket.providerDisplayName?.trim() || 'Beeline user',
        audience: result.ticket.audience,
        ...(result.ticket.providerAvatar ? { avatar: result.ticket.providerAvatar } : {}),
      };
    },
    verifyGitHubTicket: async (ticket) => {
      const result = await verifyPhoneGitHubTicket(store, tenant.community, ticket);
      if (result.status !== 'verified') throw new Error('GitHub identity exchange failed');
      return {
        ...result.identity,
        githubCredential: await store.githubUserCredential(
          tenant.community,
          result.identity.subject,
        ),
      };
    },
    sealedGitHubUserToken: async (subject) => {
      if (await store.githubUserTokenStaleAt(tenant.community, subject)) return undefined;
      return (await store.githubUserToken(tenant.community, subject)) ?? undefined;
    },
    close: () => app.close(),
  };
}
