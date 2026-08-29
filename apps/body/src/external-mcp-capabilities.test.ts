import { describe, expect, it } from 'vitest';
import {
  authorizedExternalMcpServers,
  externalMcpPermissionPolicy,
  externalMcpServers,
  governedSquireCall,
  isExternalMcpCapability,
  isExternalMcpPermissionRequest,
  isTrustySquireMcpLaunch,
} from './external-mcp-capabilities.js';

describe('Trusty Squire launch identity', () => {
  it('recognizes stable-install absolute package paths independent of launcher form', () => {
    expect(
      isTrustySquireMcpLaunch('node', [
        '/opt/beeline/node_modules/@trusty-squire/mcp/dist/bin.js',
        'server',
      ]),
    ).toBe(true);
    expect(
      isTrustySquireMcpLaunch('C:\\beeline\\node_modules\\@trusty-squire\\mcp\\dist\\bin.js', [
        'server',
      ]),
    ).toBe(true);
    expect(isTrustySquireMcpLaunch('node', ['/opt/project-tools/dist/bin.js'])).toBe(false);
  });
});

describe('external MCP capabilities', () => {
  it('mounts one secret-free broker for either independent capability', () => {
    const broker = { name: 'squire', command: 'node', args: ['proxy.js'], env: [] };
    expect(externalMcpServers(['squire-credential-use'])).toEqual([]);
    expect(externalMcpServers(['squire-credential-use'], broker)).toEqual([broker]);
    expect(externalMcpServers(['squire-app-access'], broker)).toEqual([broker]);
    expect(externalMcpServers(['squire-credential-use', 'squire-app-access'], broker)).toEqual([
      broker,
    ]);
    expect(isExternalMcpCapability('squire')).toBe(false);
  });

  it('keeps credential use and app access independently opt-in', () => {
    const call = (tool: string) => ({
      toolCall: {
        kind: 'other',
        title: `mcp__squire__${tool}`,
        rawInput: { server: 'squire', tool, arguments: {} },
      },
    });
    expect(externalMcpPermissionPolicy(call('list_credentials'), ['squire-credential-use'])).toBe(
      'allow',
    );
    expect(externalMcpPermissionPolicy(call('use_credential'), ['squire-credential-use'])).toBe(
      'allow',
    );
    expect(externalMcpPermissionPolicy(call('grant_app_access'), ['squire-credential-use'])).toBe(
      'deny',
    );
    expect(externalMcpPermissionPolicy(call('list_app_access'), ['squire-app-access'])).toBe(
      'allow',
    );
    expect(externalMcpPermissionPolicy(call('grant_app_access'), ['squire-app-access'])).toBe(
      'allow',
    );
    expect(externalMcpPermissionPolicy(call('revoke_app_access'), ['squire-app-access'])).toBe(
      'allow',
    );
    expect(externalMcpPermissionPolicy(call('use_credential'), ['squire-app-access'])).toBe('deny');
    expect(externalMcpPermissionPolicy(call('operate_start'), ['squire-app-access'])).toBe('deny');
    expect(externalMcpPermissionPolicy(call('delete_vault'), ['squire-app-access'])).toBe('deny');
    expect(externalMcpPermissionPolicy(call('observe'), [])).toBe('deny');
  });

  it('builds a secret-free exact P1 scope and rejects unbounded egress grants', () => {
    const use = governedSquireCall({
      toolCall: {
        title: 'mcp.squire.use_credential',
        rawInput: {
          server: 'squire',
          tool: 'use_credential',
          arguments: {
            service: 'github',
            http: {
              method: 'post',
              url: 'https://api.github.com/repos/acme/widgets/issues?token=not-relayed',
              headers: { authorization: '${SECRET}' },
              body: '{"sensitive":"payload"}',
            },
          },
        },
      },
    });
    expect(use?.scope).toMatchObject({
      type: 'operation.execute',
      connectorId: 'squire',
      tool: 'use_credential',
      target: 'POST https://api.github.com/repos/acme/widgets/issues via service:github',
      risk: 'out-of-scope',
    });
    expect(JSON.stringify(use?.scope)).not.toContain('not-relayed');
    expect(JSON.stringify(use?.scope)).not.toContain('sensitive');
    expect(use?.scope.argumentsDigest).toMatch(/^[0-9a-f]{64}$/);

    const grant = (args: Record<string, unknown>) =>
      governedSquireCall({
        toolCall: {
          title: 'mcp__squire__grant_app_access',
          rawInput: { server: 'squire', tool: 'grant_app_access', arguments: args },
        },
      });
    expect(grant({ service: 'clerk' })).toBeUndefined();
    expect(grant({ service: 'clerk', rate_limit_per_hour: 100 })?.scope.target).toContain(
      'max 100 requests/hour',
    );
  });

  it('mounts account capabilities only for creator-scoped agents', () => {
    expect(authorizedExternalMcpServers('everyone', ['squire-credential-use'])).toEqual([]);
    expect(authorizedExternalMcpServers(undefined, ['squire-credential-use'])).toEqual([]);
    expect(authorizedExternalMcpServers('creator', ['squire-credential-use'])).toEqual([]);
    expect(
      authorizedExternalMcpServers('creator', ['squire-credential-use'], {
        name: 'squire',
        command: 'node',
        args: ['proxy.js'],
        env: [],
      }),
    ).toHaveLength(1);
  });

  it('recognizes both adapter spellings but never a shell-title spoof', () => {
    expect(
      isExternalMcpPermissionRequest(
        {
          toolCall: {
            title: 'mcp.squire.list_credentials',
            rawInput: { server: 'squire', tool: 'list_credentials', arguments: {} },
          },
        },
        ['squire-credential-use'],
      ),
    ).toBe(true);
    expect(
      isExternalMcpPermissionRequest(
        { toolCall: { kind: 'other', title: 'mcp__squire__operate_start', rawInput: {} } },
        ['squire-credential-use'],
      ),
    ).toBe(true);
    expect(
      isExternalMcpPermissionRequest(
        {
          toolCall: {
            kind: 'execute',
            title: 'mcp__squire__operate_start',
            rawInput: { command: 'mcp__squire__operate_start' },
          },
        },
        ['squire-credential-use'],
      ),
    ).toBe(false);
    expect(
      isExternalMcpPermissionRequest(
        {
          toolCall: {
            kind: 'edit',
            title: 'mcp__squire__operate_start',
            rawInput: { path: '/tmp/not-squire' },
          },
        },
        ['squire-credential-use'],
      ),
    ).toBe(false);
  });
});
