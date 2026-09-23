import { describe, expect, it } from 'vitest';
import { MCP_ROUTE_CLASS_KEY, MCP_ROUTE_HOST } from './mcp-route-class.js';
import {
  claimGrantedHostRoutes,
  grantedMcpServerNames,
  grantedHostRoutesFromList,
  grantedHostRouteWires,
  grantedSquireHostRoute,
  grantedSquireHostRouteNames,
  hostRouteEnv,
  mergeJsonHostRoutes,
  mergeTomlHostRoutes,
  rewriteGrantedHostRoutes,
  rewriteHostMcpDeclaration,
  ungatedHostServers,
} from './host-mcp-route.js';
import { squireHostRewriteEnv } from './squire-host.js';

describe('granted MCP host routes', () => {
  it('claims a Once route for one activation and refuses an unclaimable route', async () => {
    const claimed: string[] = [];
    const names = await claimGrantedHostRoutes(
      {
        grants: [
          { grantId: 'one', kind: 'mcp', target: 'squire', status: 'once' },
          { grantId: 'bad', kind: 'mcp', target: 'browser', status: 'once' },
          { grantId: 'standing', kind: 'mcp', target: 'files', status: 'approved' },
        ],
      },
      async (grantId) => {
        if (grantId === 'bad') throw new Error('already used');
        claimed.push(grantId);
      },
    );
    expect(names).toEqual(['squire', 'files']);
    expect(claimed).toEqual(['one']);
  });
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
    expect(rewritten.args).toEqual(
      expect.arrayContaining([expect.stringMatching(/squire-facade/)]),
    );
    expect(rewritten.env).toEqual(squireHostRewriteEnv('/home/op'));
    expect(rewritten).not.toHaveProperty(MCP_ROUTE_CLASS_KEY);
  });

  it('routes a non-Squire host server at host state instead of copying the launch line', () => {
    const rewritten = rewriteHostMcpDeclaration(
      'browser',
      { command: 'browser-mcp', [MCP_ROUTE_CLASS_KEY]: MCP_ROUTE_HOST },
      '/home/op',
    );
    expect(rewritten).toEqual({
      command: 'browser-mcp',
      env: { XDG_CONFIG_HOME: '/home/op/.config' },
    });
    expect(rewritten.env).toEqual(hostRouteEnv('/home/op'));
    expect(rewritten.env).not.toHaveProperty('TRUSTY_SQUIRE_PROFILE_DIR');
  });

  it('answers whether a grant reaches Squire, not merely some host server', () => {
    const declarations = {
      browser: { command: 'browser-mcp' },
      vault: { command: 'npx', args: ['-y', '@trusty-squire/mcp@latest', 'server'] },
    };
    expect(grantedSquireHostRoute(['browser'], declarations)).toBe(false);
    expect(grantedSquireHostRoute(['vault'], declarations)).toBe(true);
    expect(grantedSquireHostRoute(['squire'], {})).toBe(true);
    expect(grantedSquireHostRoute([], declarations)).toBe(false);
    expect(grantedSquireHostRouteNames(['browser', 'vault', 'squire'], declarations)).toEqual([
      'vault',
      'squire',
    ]);
    expect(
      grantedSquireHostRouteNames(['broker'], {
        broker: {
          command: 'custom-facade',
          env: { TRUSTY_SQUIRE_BROKER_SOCKET: '/home/op/.trusty-squire/broker.sock' },
        },
      }),
    ).toEqual(['broker']);
  });

  it('rewrites a code-owned Squire grant with no operator declaration', () => {
    // Grant target is the code-owned name `squire`. The operator file may
    // use another key or be missing; the name itself is still the route.
    const rewritten = rewriteGrantedHostRoutes({}, ['squire'], '/home/op');
    expect(Object.keys(rewritten)).toEqual(['squire']);
    expect(rewritten.squire?.env).toEqual(squireHostRewriteEnv('/home/op'));
    expect(rewritten.squire).not.toHaveProperty(MCP_ROUTE_CLASS_KEY);
  });

  it('turns a standing always mcp grant into session wires that survive a restart read', () => {
    // Candy's live shape: two unexpired status=approved mcp/squire rows.
    // listAgentGrants returns both; the next session and the session after a
    // daemon restart must produce the same façade wire without another card.
    const standing = {
      grants: [
        { kind: 'mcp', target: 'squire', status: 'approved' },
        { kind: 'mcp', target: 'squire', status: 'approved' },
      ],
    };
    const names = grantedHostRoutesFromList(standing);
    expect(names).toEqual(['squire']);
    const first = grantedHostRouteWires(names, '/home/op');
    const afterRestart = grantedHostRouteWires(grantedHostRoutesFromList(standing), '/home/op');
    expect(first).toEqual(afterRestart);
    expect(first).toEqual([
      expect.objectContaining({
        name: 'squire',
        command: process.execPath,
        args: expect.arrayContaining([expect.stringMatching(/squire-facade/)]),
        env: expect.arrayContaining(
          Object.entries(squireHostRewriteEnv('/home/op')).map(([name, value]) => ({
            name,
            value,
          })),
        ),
      }),
    ]);
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
    const merged = mergeTomlHostRoutes('[mcp_servers.files]\ncommand = "files-mcp"\n', {
      squire: rewriteHostMcpDeclaration('squire', { command: 'squire-mcp' }, '/home/op'),
    });
    expect(merged).toContain('files-mcp');
    expect(merged).toContain('TRUSTY_SQUIRE_BROKER_SOCKET');
    expect(merged).not.toContain('squire-mcp');
  });

  it('merges rewritten routes into Claude JSON', () => {
    const merged = mergeJsonHostRoutes(
      { files: { command: 'files-mcp' } },
      { squire: rewriteHostMcpDeclaration('squire', { command: 'squire-mcp' }, '/home/op') },
    );
    expect(merged?.files).toEqual({ command: 'files-mcp' });
    expect(
      (merged?.squire as { env: Record<string, string> }).env.TRUSTY_SQUIRE_BROKER_SOCKET,
    ).toBe('/home/op/.trusty-squire/broker.sock');
  });
});
