import type { AuthRouteContext } from './server-context.js';
export function registerServerGithubManifestRoutes(context: AuthRouteContext): void {
  const {
    app,
    options,
    tenantFor,
    noStore,
    githubAppSetupFormPage,
    githubAppSetupEnvPage,
    githubAppSetupErrorPage,
    ProtocolError,
    appSetupEnvBlock,
    buildAppManifest,
    checkGitHubAppDriftBestEffort,
    convertAppManifestCode,
    setupTokenMatches,
  } = context;
  app.get('/auth/github/app-setup', async (request, reply) => {
    if (!options.githubSetupToken) {
      throw new ProtocolError(
        503,
        'github_setup_disabled',
        'GitHub App setup is not enabled on this service',
      );
    }
    const tenant = tenantFor(request);
    const query = request.query as Record<string, unknown>;
    if (!setupTokenMatches(query?.token, options.githubSetupToken)) {
      throw new ProtocolError(403, 'invalid_setup_token', 'invalid or missing setup token');
    }
    noStore(reply);
    const code = typeof query.code === 'string' && query.code ? query.code : undefined;
    if (!code) {
      // The gate token rides INSIDE the manifest redirect_url so GitHub's
      // post-creation redirect (?code=...) lands back here still authorized.
      const redirectUrl = `${tenant.origin}/auth/github/app-setup?token=${encodeURIComponent(options.githubSetupToken)}`;
      return reply
        .type('text/html; charset=utf-8')
        .send(
          githubAppSetupFormPage(
            buildAppManifest({ name: 'Beeline', origin: tenant.origin, redirectUrl }),
          ),
        );
    }
    try {
      const conversion = await convertAppManifestCode('https://api.github.com', code);
      request.log.info(
        { appId: conversion.appId, slug: conversion.slug },
        'GitHub App created via manifest flow',
      );
      return reply
        .type('text/html; charset=utf-8')
        .send(githubAppSetupEnvPage(appSetupEnvBlock(conversion), conversion.htmlUrl));
    } catch (error) {
      request.log.warn({ err: error }, 'GitHub App manifest conversion failed');
      return reply
        .code(502)
        .type('text/html; charset=utf-8')
        .send(githubAppSetupErrorPage(error instanceof Error ? error.message : String(error)));
    }
  });

  app.get('/auth/github/app-drift', async (request, reply) => {
    if (!options.github) {
      throw new ProtocolError(503, 'github_unavailable', 'GitHub is not configured');
    }
    if (!options.githubSetupToken) {
      throw new ProtocolError(
        503,
        'github_setup_disabled',
        'GitHub App setup is not enabled on this service',
      );
    }
    const query = request.query as Record<string, unknown>;
    if (!setupTokenMatches(query?.token, options.githubSetupToken)) {
      throw new ProtocolError(403, 'invalid_setup_token', 'invalid or missing setup token');
    }
    const drift = await checkGitHubAppDriftBestEffort(options.github.app, (line) =>
      request.log.info(line),
    );
    noStore(reply);
    return reply.send(drift ? { drift } : { drift: null });
  });
}
