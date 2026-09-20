import { describe, expect, it } from 'vitest';
import { MCP_ROUTE_CLASS_KEY, MCP_ROUTE_HOST } from './mcp-route-class.js';
import {
  grantedMcpServerNames,
  grantedHostRoutesFromList,
  mergeJsonHostRoutes,
  mergeTomlHostRoutes,
  rewriteGrantedHostRoutes,
  rewriteHostMcpDeclaration,
  squireSessionUnmaskPaths,
  ungatedHostServers,
} from './host-mcp-route.js';
import { squireHostRewriteEnv } from './squire-host.js';

describe('granted MCP host routes', () => {
  it('collects mcp grant targets and drops them from the host gate', () => {
    expect(
      grantedMcpServerNames([
        { kind: 'command', target: 'npm test' },
        { kind: 'mcp', target: 'squire' },
        { kind: 'mcp', target: ' browser ' },
      ]),
    ).toEqual(['squire', 'browser']);
    expect(ungatedHostServers(['squire', 'browser', 'vault'], ['squire'])).toEqual([
      'browser',
      'vault',
    ]);
    expect(
      grantedHostRoutesFromList({
        grants: [
          { kind: 'mcp', target: 'squire' },
          { kind: 'command', target: 'npm test' },
        ],
      }),
    ).toEqual(['squire']);
    expect(grantedHostRoutesFromList({ id: 'write-id' })).toEqual([]);
  });

  it('rewrites Squire into a façade route with the three host variables', () => {
    const rewritten = rewriteHostMcpDeclaration(
      'squire',
      { command: 'npx', args: ['-y', '@trusty-squire/mcp@latest', 'server'] },
      '/home/op',
    );
    expect(rewritten.command).toBe(process.execPath);
    expect(rewritten.args).toEqual(expect.arrayContaining([expect.stringMatching(/squire-facade/)]));
    expect(rewritten.env).toEqual(squireHostRewriteEnv('/home/op'));
    expect(rewritten).not.toHaveProperty(MCP_ROUTE_CLASS_KEY);
  });

  it('keeps a non-Squire host server command and does not copy a Chrome profile', () => {
    const rewritten = rewriteHostMcpDeclaration(
      'browser',
      { command: 'browser-mcp', [MCP_ROUTE_CLASS_KEY]: MCP_ROUTE_HOST },
      '/home/op',
    );
    expect(rewritten).toEqual({ command: 'browser-mcp' });
  });

  it('writes only granted host routes', () => {
    const rewritten = rewriteGrantedHostRoutes(
      {
        squire: { command: 'squire-mcp' },
        browser: { command: 'browser-mcp', [MCP_ROUTE_CLASS_KEY]: MCP_ROUTE_HOST },
        files: { command: 'files-mcp' },
      },
      ['squire'],
      '/home/op',
    );
    expect(Object.keys(rewritten)).toEqual(['squire']);
    expect(rewritten.squire?.env).toEqual(squireHostRewriteEnv('/home/op'));
  });

  it('merges rewritten routes into an isolated TOML home without the operator copy', () => {
    const merged = mergeTomlHostRoutes(
      '[mcp_servers.files]\ncommand = "files-mcp"\n',
      {
        squire: rewriteHostMcpDeclaration('squire', { command: 'squire-mcp' }, '/home/op'),
      },
    );
    expect(merged).toContain('files-mcp');
    expect(merged).toContain('TRUSTY_SQUIRE_BROKER_SOCKET');
    expect(merged).not.toContain('squire-mcp');
  });

  it('unmasks only the Squire session dir when that host route is granted', () => {
    expect(squireSessionUnmaskPaths('/home/op', [], { squire: { command: 'squire-mcp' } })).toEqual(
      [],
    );
    expect(
      squireSessionUnmaskPaths('/home/op', ['browser'], {
        browser: { command: 'browser-mcp' },
      }),
    ).toEqual([]);
    expect(squireSessionUnmaskPaths('/home/op', ['squire'])).toEqual(['/home/op/.config/trusty-squire']);
    expect(
      squireSessionUnmaskPaths('/home/op', ['vault'], {
        vault: { command: 'npx', args: ['-y', '@trusty-squire/mcp@latest', 'server'] },
      }),
    ).toEqual(['/home/op/.config/trusty-squire']);
  });

  it('merges rewritten routes into Claude JSON', () => {
    const merged = mergeJsonHostRoutes(
      { files: { command: 'files-mcp' } },
      { squire: rewriteHostMcpDeclaration('squire', { command: 'squire-mcp' }, '/home/op') },
    );
    expect(merged?.files).toEqual({ command: 'files-mcp' });
    expect((merged?.squire as { env: Record<string, string> }).env.TRUSTY_SQUIRE_BROKER_SOCKET).toBe(
      '/home/op/.trusty-squire/broker.sock',
    );
  });
});
