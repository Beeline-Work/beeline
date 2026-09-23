import { describe, expect, it } from 'vitest';
import {
  classifyImportedMcpServer,
  isHostMcpIdentity,
  MCP_ROUTE_CLASS_KEY,
  MCP_ROUTE_HOST,
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
    expect(
      classifyImportedMcpServer({
        name: 'vault',
        declaration: {
          command: 'custom-facade',
          env: { TRUSTY_SQUIRE_BROKER_SOCKET: '/home/op/.trusty-squire/broker.sock' },
        },
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
        declaration: { cmd: 'browser-mcp', [MCP_ROUTE_CLASS_KEY]: MCP_ROUTE_HOST },
      }),
    ).toBe('host');
    expect(
      classifyImportedMcpServer({
        name: 'browser',
        declaration: { command: 'browser-mcp', [MCP_ROUTE_CLASS_KEY]: 'local' },
      }),
    ).toBe('local');
  });

  it('matches host identities across harness permission spellings', () => {
    expect(isHostMcpIdentity('squire')).toBe(true);
    expect(isHostMcpIdentity('mcp__squire__use_credential')).toBe(true);
    expect(isHostMcpIdentity('mcp.squire.use_credential')).toBe(true);
    expect(isHostMcpIdentity('squire__use_credential')).toBe(true);
    expect(isHostMcpIdentity('files-mcp', ['squire'])).toBe(false);
    expect(isHostMcpIdentity('mcp.browser.read', ['browser'])).toBe(true);
  });
});
