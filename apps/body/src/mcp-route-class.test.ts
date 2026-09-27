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

  it('requires resource authority even for locally launched tools', () => {
    expect(classifyImportedMcpServer({ name: 'files', command: 'files-mcp' })).toBe('host');
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
    ).toBe('host');
  });

  it('copies credential-free public HTTPS routes without an owner grant', () => {
    expect(
      classifyImportedMcpServer({
        name: 'reference',
        declaration: { url: 'https://docs.example.test/mcp', enabled: true },
      }),
    ).toBe('local');
  });

  it.each([
    { url: 'https://docs.example.test/mcp', headers: { authorization: 'Bearer secret' } },
    { url: 'https://docs.example.test/mcp', bearer_token_env_var: 'API_TOKEN' },
    { url: 'https://user:password@docs.example.test/mcp' },
    { url: 'https://docs.example.test/mcp?key=secret' },
    { url: 'http://docs.example.test/mcp' },
    { url: 'https://localhost/mcp' },
    { url: 'https://127.0.0.1/mcp' },
    { url: 'https://internal.local/mcp' },
    { url: 'https://docs.example.test/mcp', command: 'spend-money' },
  ])('keeps an authority-bearing or ambiguous route behind the grant gate: %j', (declaration) => {
    expect(classifyImportedMcpServer({ name: 'reference', declaration })).toBe('host');
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
