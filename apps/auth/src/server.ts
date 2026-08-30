import type { FastifyInstance } from 'fastify';
import { createAuthRouteContext, type AuthServerOptions } from './server-context.js';
import { registerServerGithubEventsRoutes } from './server-github-events-routes.js';
import { registerServerGithubInstallationRoutes } from './server-github-installation-routes.js';
import { registerServerGithubManifestRoutes } from './server-github-manifest-routes.js';
import { registerServerNip05Routes } from './server-nip05-routes.js';
import { registerServerOidcIdentityRoutes } from './server-oidc-identity-routes.js';

export {
  GITHUB_REPO_EVENT_TYPES,
  type AuthServerOptions,
  type AuthTenant,
  type GitHubRoomTokenAuthorityFailureReason,
  type GitHubRoomTokenAuthorityResult,
} from './server-context.js';

export function buildAuthServer(options: AuthServerOptions): FastifyInstance {
  const context = createAuthRouteContext(options);
  registerServerOidcIdentityRoutes(context);
  registerServerGithubInstallationRoutes(context);
  registerServerGithubEventsRoutes(context);
  registerServerNip05Routes(context);
  registerServerGithubManifestRoutes(context);
  return context.app;
}
