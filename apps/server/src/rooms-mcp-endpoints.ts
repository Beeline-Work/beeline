import type { IncomingMessage } from 'node:http';

/** Fixed alias only: forwarded headers and arbitrary Host values never become OAuth URLs. */
export function joinOrigin(origin: string, hostname = 'join.usebeeline.app'): string {
  const url = new URL(origin);
  const alias = new URL(`https://${hostname}`);
  if (alias.hostname !== hostname.toLowerCase() || alias.port || alias.pathname !== '/' ||
      alias.username || alias.password || alias.search || alias.hash)
    throw new Error('Invalid MCP join hostname');
  return `${url.protocol}//${alias.hostname}${url.port ? `:${url.port}` : ''}`;
}

export function mcpEndpoint(request: IncomingMessage, origin: string, hostname?: string): URL | undefined {
  const path = new URL(request.url ?? '/', origin).pathname;
  const short = joinOrigin(origin, hostname);
  const base = request.headers.host?.toLowerCase() === new URL(short).host ? short : origin;
  if (path === '/mcp' || path === '/join' || (base === short && path === '/')) return new URL(path, base);
  return undefined;
}

export function resourceMetadataUrl(endpoint: URL): string {
  return `${endpoint.origin}/.well-known/oauth-protected-resource${endpoint.pathname === '/' ? '' : endpoint.pathname}`;
}
