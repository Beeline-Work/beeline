import { describe, expect, it, vi } from 'vitest';
import { McpRegistryClient, normalizeRegistryServer } from './mcp-registry.js';

const LINEAR = {
  server: {
    name: 'app.linear/linear',
    version: '1.0.1',
    title: 'Linear',
    description: 'Linear official MCP server',
    websiteUrl: 'https://linear.app',
    repository: { url: 'https://github.com/linear/linear', source: 'github' },
    remotes: [
      { type: 'streamable-http', url: 'https://mcp.linear.app/mcp' },
      { type: 'stdio', url: 'https://ignored.example/stdio' },
      { type: 'sse', url: 'http://insecure.example/sse' },
    ],
    packages: [{ registryType: 'npm', identifier: '@linear/mcp', version: '1.0.1' }],
    environmentVariables: [
      { name: 'LINEAR_API_KEY', isSecret: true, value: 'must-not-cross-the-boundary' },
      { name: 'LINEAR_TEAM', isSecret: false, value: 'ENG' },
    ],
  },
};

describe('McpRegistryClient', () => {
  it('normalizes presentation and provenance while exposing secret names only', () => {
    const manifest = normalizeRegistryServer(LINEAR);
    expect(manifest).toEqual({
      name: 'app.linear/linear',
      version: '1.0.1',
      title: 'Linear',
      description: 'Linear official MCP server',
      websiteUrl: 'https://linear.app/',
      repository: { url: 'https://github.com/linear/linear', source: 'github' },
      remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
      packages: [{ registryType: 'npm', identifier: '@linear/mcp', version: '1.0.1' }],
      secretInputNames: ['LINEAR_API_KEY'],
    });
    expect(JSON.stringify(manifest)).not.toContain('must-not-cross-the-boundary');
    expect(JSON.stringify(manifest)).not.toContain('ENG');
  });

  it('caps search at ten, caches searches, and always refetches exact selections', async () => {
    const requested: string[] = [];
    let exactVersion = 0;
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requested.push(url.toString());
      if (url.pathname === '/v0.1/servers') {
        return new Response(JSON.stringify({ servers: [LINEAR] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      exactVersion += 1;
      return new Response(
        JSON.stringify({
          server: { ...LINEAR.server, description: `fresh-${exactVersion}` },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const registry = new McpRegistryClient(transport);

    await expect(registry.search('Linear', 99)).resolves.toHaveLength(1);
    await expect(registry.search('Linear', 99)).resolves.toHaveLength(1);
    expect(requested.filter((url) => new URL(url).pathname === '/v0.1/servers')).toHaveLength(1);
    expect(new URL(requested[0]!).searchParams.get('limit')).toBe('10');
    expect(new URL(requested[0]!).searchParams.get('version')).toBe('latest');

    await expect(registry.exact('app.linear/linear', '1.0.1')).resolves.toMatchObject({
      description: 'fresh-1',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
    });
    await expect(registry.exact('app.linear/linear', '1.0.1')).resolves.toMatchObject({
      description: 'fresh-2',
    });
    expect(requested.filter((url) => new URL(url).pathname.includes('/versions/'))).toHaveLength(2);
    expect(new URL(requested.at(-1)!).pathname).toBe(
      '/v0.1/servers/app.linear%2Flinear/versions/1.0.1',
    );
  });
});
