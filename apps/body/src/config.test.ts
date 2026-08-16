import { describe, expect, it } from 'vitest';

import { loadBodyConfig, resolveCodegraphCommand, resolveReadonlyMcpCommand } from './config.js';

const binaryEnv = {
  BUZZ_AGENT_BIN: process.execPath,
  BUZZ_DEV_MCP_BIN: process.execPath,
  BUZZ_READONLY_MCP_BIN: process.execPath,
};

describe('loadBodyConfig relay resolution', () => {
  it('uses production HTTP and WebSocket endpoints in a clean environment', () => {
    const config = loadBodyConfig({ workspaceRoot: '.', env: binaryEnv });

    expect(config.relayHost).toBe('relay.buzzrouter.com');
    expect(config.relayScheme).toBe('https');
    expect(config.relayBaseUrl).toBe('https://relay.buzzrouter.com');
    expect(config.relayWsUrl).toBe('wss://relay.buzzrouter.com');
  });

  it('retains every supported relay override', () => {
    const config = loadBodyConfig({
      workspaceRoot: '.',
      env: {
        ...binaryEnv,
        BUZZY_RELAY_HOST: 'local.test:3010',
        BUZZY_RELAY_SCHEME: 'http',
        BUZZY_RELAY_URL: 'ws://http-override.test:3400/',
        BUZZY_RELAY_WS: 'ws://legacy-ws.test',
        BUZZ_RELAY_URL: 'wss://preferred-ws.test',
      },
    });

    expect(config.relayHost).toBe('local.test:3010');
    expect(config.relayScheme).toBe('http');
    expect(config.relayBaseUrl).toBe('http://http-override.test:3400');
    expect(config.relayWsUrl).toBe('wss://preferred-ws.test');
  });

  it('keeps BUZZY_RELAY_WS as the legacy WebSocket override', () => {
    const config = loadBodyConfig({
      workspaceRoot: '.',
      env: { ...binaryEnv, BUZZY_RELAY_WS: 'ws://legacy-ws.test' },
    });

    expect(config.relayWsUrl).toBe('ws://legacy-ws.test');
  });
});

describe('resolveReadonlyMcpCommand', () => {
  it('fails clearly when an explicit helper path is not executable', () => {
    expect(() =>
      resolveReadonlyMcpCommand({
        PATH: '',
        BUZZ_READONLY_MCP_BIN: '/definitely/missing/buzz-readonly-mcp',
      }),
    ).toThrow('read-only tools unavailable');
  });
});

describe('resolveCodegraphCommand', () => {
  it('resolves an explicit, executable override', () => {
    expect(resolveCodegraphCommand({ PATH: '', BUZZ_CODEGRAPH_BIN: process.execPath })).toBe(
      process.execPath,
    );
  });

  it('is best-effort: an unusable override returns undefined instead of throwing', () => {
    expect(() =>
      resolveCodegraphCommand({
        PATH: '',
        BUZZ_CODEGRAPH_BIN: '/definitely/missing/codegraph',
      }),
    ).not.toThrow();
    expect(
      resolveCodegraphCommand({ PATH: '', BUZZ_CODEGRAPH_BIN: '/definitely/missing/codegraph' }),
    ).toBeUndefined();
  });

  it('is best-effort: no override and nothing on PATH returns undefined instead of throwing', () => {
    expect(() => resolveCodegraphCommand({ PATH: '' })).not.toThrow();
    expect(resolveCodegraphCommand({ PATH: '' })).toBeUndefined();
  });
});
