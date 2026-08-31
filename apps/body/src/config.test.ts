import { describe, expect, it } from 'vitest';

import {
  buildAgentEnv,
  loadBodyConfig,
  parseSandboxMaskEnv,
  resolveCodegraphCommand,
  resolveReadonlyMcpCommand,
} from './config.js';

const binaryEnv = {
  BUZZ_AGENT_BIN: process.execPath,
  BUZZ_DEV_MCP_BIN: process.execPath,
  BUZZ_READONLY_MCP_BIN: process.execPath,
};

describe('loadBodyConfig relay resolution', () => {
  it('uses production HTTP and WebSocket endpoints in a clean environment', () => {
    const config = loadBodyConfig({ workspaceRoot: '.', env: binaryEnv });

    expect(config.relayHost).toBe('usebeeline.app');
    expect(config.relayScheme).toBe('https');
    expect(config.relayBaseUrl).toBe('https://usebeeline.app');
    expect(config.relayWsUrl).toBe('wss://usebeeline.app');
  });

  it('keeps an explicitly configured legacy relay alias unchanged', () => {
    const config = loadBodyConfig({
      workspaceRoot: '.',
      env: {
        ...binaryEnv,
        BUZZY_RELAY_HOST: 'relay.buzzrouter.com',
        BUZZY_RELAY_URL: 'https://relay.buzzrouter.com',
      },
    });

    expect(config.relayHost).toBe('relay.buzzrouter.com');
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

describe('buildAgentEnv passthrough boundary', () => {
  // AcpClient.start() used to spread the daemon's whole process.env underneath
  // this map, so the allowlist described nothing. It is the child's entire
  // environment now, which only works if it actually carries what a harness
  // needs — and only what a harness needs.
  const daemonEnv = {
    PATH: '/usr/bin',
    HOME: '/home/operator',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    SSH_AUTH_SOCK: '/run/ssh-agent.sock',
    HTTPS_PROXY: 'http://proxy.test:3128',
    NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    ANTHROPIC_API_KEY: 'anthropic-key',
    CLAUDE_CONFIG_DIR: '/home/operator/.claude',
    GITHUB_TOKEN: 'gh-token',
    BUZZ_DEV_MCP_BIN: '/usr/bin/buzz-dev-mcp',
    JAVA_HOME: '/usr/lib/jvm/default',
    CARGO_HOME: '/home/operator/.cargo',
    UNRELATED_DEPLOY_SECRET: 'do-not-leak',
    STRIPE_SECRET_KEY: 'do-not-leak',
  };

  it('carries the harness, toolchain, locale, proxy and TLS context a coding agent needs', () => {
    const agentEnv = buildAgentEnv(daemonEnv);

    expect(agentEnv).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/operator',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy.test:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      ANTHROPIC_API_KEY: 'anthropic-key',
      CLAUDE_CONFIG_DIR: '/home/operator/.claude',
      BUZZ_DEV_MCP_BIN: '/usr/bin/buzz-dev-mcp',
      // A corner agent builds the user's project inside its worktree, so the
      // toolchain environment has to survive the boundary.
      JAVA_HOME: '/usr/lib/jvm/default',
      CARGO_HOME: '/home/operator/.cargo',
    });
    expect(agentEnv.TMPDIR).toBeTruthy();
  });

  it('does not hand every ACP child every unrelated secret the daemon holds', () => {
    const agentEnv = buildAgentEnv(daemonEnv);

    expect(agentEnv.UNRELATED_DEPLOY_SECRET).toBeUndefined();
    expect(agentEnv.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('extends the boundary through BUZZY_BODY_AGENT_ENV_PASSTHROUGH without a code change', () => {
    const agentEnv = buildAgentEnv({
      ...daemonEnv,
      BUZZY_BODY_AGENT_ENV_PASSTHROUGH: 'UNRELATED_DEPLOY_SECRET, MISSING_VAR',
    });

    expect(agentEnv.UNRELATED_DEPLOY_SECRET).toBe('do-not-leak');
    expect(agentEnv.STRIPE_SECRET_KEY).toBeUndefined();
    expect(agentEnv.MISSING_VAR).toBeUndefined();
  });

  it('does not copy ambient GitHub tokens unless explicitly configured', () => {
    const agentEnv = buildAgentEnv({
      ...daemonEnv,
      GH_TOKEN: 'gh-cli-token',
      GH_ENTERPRISE_TOKEN: 'ghes-token',
      GIT_ASKPASS: '/bin/true',
    });

    expect(agentEnv.GITHUB_TOKEN).toBeUndefined();
    expect(agentEnv.GH_TOKEN).toBeUndefined();
    expect(agentEnv.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(agentEnv.SSH_AUTH_SOCK).toBe('/run/ssh-agent.sock');
  });

  it('allows an explicit operator passthrough now that the credential denylist is gone', () => {
    const agentEnv = buildAgentEnv({
      ...daemonEnv,
      BUZZY_BODY_AGENT_ENV_PASSTHROUGH: 'GITHUB_TOKEN,GH_TOKEN,SSH_AUTH_SOCK',
      GITHUB_TOKEN: 'github-token',
      GH_TOKEN: 'gh-token',
      SSH_AUTH_SOCK: '/tmp/ssh.sock',
    });

    expect(agentEnv.GITHUB_TOKEN).toBe('github-token');
    expect(agentEnv.GH_TOKEN).toBe('gh-token');
    expect(agentEnv.SSH_AUTH_SOCK).toBe('/tmp/ssh.sock');
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

describe('sandbox mask configuration', () => {
  it('parses BUZZY_BODY_SANDBOX_MASK as a comma/newline-separated path list', () => {
    expect(parseSandboxMaskEnv({ BUZZY_BODY_SANDBOX_MASK: '/srv/secrets, /etc/creds\n/home/op/.envs' })).toEqual([
      '/srv/secrets',
      '/etc/creds',
      '/home/op/.envs',
    ]);
  });

  it('is absent when unset or empty', () => {
    expect(parseSandboxMaskEnv({})).toBeUndefined();
    expect(parseSandboxMaskEnv({ BUZZY_BODY_SANDBOX_MASK: '  ' })).toBeUndefined();
    expect(parseSandboxMaskEnv({ BUZZY_BODY_SANDBOX_MASK: ',,' })).toBeUndefined();
  });

  it('loadBodyConfig carries the mask list through', () => {
    const config = loadBodyConfig({
      workspaceRoot: '/tmp/workspace',
      env: {
        ...binaryEnv,
        PATH: process.env.PATH ?? '',
        BUZZY_BODY_SANDBOX_MASK: '/srv/operator-secrets',
      },
    });
    expect(config.sandboxMaskPaths).toEqual(['/srv/operator-secrets']);
  });
});
