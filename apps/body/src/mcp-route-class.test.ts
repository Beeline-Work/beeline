import { describe, expect, it } from 'vitest';
import {
  classifyImportedMcpServer,
  hostRouteEnv,
  isHostMcpIdentity,
  MCP_ROUTE_CLASS_ENV_KEY,
  MCP_ROUTE_CLASS_KEY,
  MCP_ROUTE_HOST,
  rewriteHostMcpDeclaration,
} from './mcp-route-class.js';

describe('imported MCP host/local classification', () => {
  it('treats code-owned squire as host by name, independent of the launch spelling', () => {
    expect(classifyImportedMcpServer({ name: 'squire' })).toBe('host');
    expect(classifyImportedMcpServer({ name: 'Squire', command: 'squire-mcp' })).toBe('host');
    expect(
      classifyImportedMcpServer({
        name: 'vault',
        command: 'npx',
        args: ['-y', '@trusty-squire/mcp'],
      }),
    ).toBe('host');
  });

  it('treats everything else as local unless the operator marks the one host key', () => {
    expect(classifyImportedMcpServer({ name: 'files', command: 'files-mcp' })).toBe('local');
    expect(
      classifyImportedMcpServer({
        name: 'browser',
        command: 'browser-mcp',
        declaration: { command: 'browser-mcp', [MCP_ROUTE_CLASS_KEY]: MCP_ROUTE_HOST },
      }),
    ).toBe('host');
    expect(
      classifyImportedMcpServer({
        name: 'browser',
        declaration: { command: 'browser-mcp', env: { [MCP_ROUTE_CLASS_ENV_KEY]: MCP_ROUTE_HOST } },
      }),
    ).toBe('host');
  });

  it('rewrites a host declaration by keeping the command and pointing env at the host', () => {
    const rewritten = rewriteHostMcpDeclaration(
      { command: 'npx', args: ['-y', '@trusty-squire/mcp'], [MCP_ROUTE_CLASS_KEY]: MCP_ROUTE_HOST },
      '/home/op',
      'squire',
    );
    expect(rewritten.command).toBe('npx');
    expect(rewritten.args).toEqual(['-y', '@trusty-squire/mcp']);
    expect(rewritten).not.toHaveProperty(MCP_ROUTE_CLASS_KEY);
    expect(rewritten.env).toEqual({
      [MCP_ROUTE_CLASS_ENV_KEY]: MCP_ROUTE_HOST,
      HOME: '/home/op',
      TRUSTY_SQUIRE_PROFILE_DIR: '/home/op/.trusty-squire/chrome-profile',
      XDG_CONFIG_HOME: '/home/op/.config',
    });
  });

  it('does not attach Squire env to an operator-marked host that is not Squire', () => {
    const rewritten = rewriteHostMcpDeclaration(
      { cmd: 'browser-mcp', [MCP_ROUTE_CLASS_KEY]: MCP_ROUTE_HOST },
      '/home/op',
      'browser',
    );
    expect(rewritten.cmd).toBe('browser-mcp');
    expect(rewritten.envs).toEqual({
      [MCP_ROUTE_CLASS_ENV_KEY]: MCP_ROUTE_HOST,
      HOME: '/home/op',
    });
    expect(rewritten).not.toHaveProperty('env');
  });

  it('keeps Goose envs as envs when rewriting a host extension', () => {
    const rewritten = rewriteHostMcpDeclaration(
      { cmd: 'npx', args: ['-y', '@trusty-squire/mcp'], envs: { EXISTING: '1' } },
      '/home/op',
      'squire',
    );
    expect(rewritten).not.toHaveProperty('env');
    expect(rewritten.envs).toMatchObject({
      EXISTING: '1',
      [MCP_ROUTE_CLASS_ENV_KEY]: MCP_ROUTE_HOST,
      HOME: '/home/op',
    });
  });

  it('matches host identities across harness permission spellings', () => {
    expect(isHostMcpIdentity('squire')).toBe(true);
    expect(isHostMcpIdentity('mcp__squire__use_credential')).toBe(true);
    expect(isHostMcpIdentity('mcp.squire.use_credential')).toBe(true);
    expect(isHostMcpIdentity('squire__use_credential')).toBe(true);
    expect(isHostMcpIdentity('files-mcp', ['squire'])).toBe(false);
    expect(isHostMcpIdentity('mcp.browser.read', ['browser'])).toBe(true);
  });

  it('points host-route env at the operator home without copying a profile path as bytes', () => {
    const env = hostRouteEnv('squire', '/home/op');
    expect(env.TRUSTY_SQUIRE_PROFILE_DIR).toBe('/home/op/.trusty-squire/chrome-profile');
    expect(Object.values(env).every((value) => !value.includes('\0'))).toBe(true);
  });
});
