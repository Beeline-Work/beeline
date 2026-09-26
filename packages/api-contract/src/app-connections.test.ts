import { describe, expect, it } from 'vitest';
import {
  APP_ROUTES,
  appIdentity,
  appKeyForHost,
  appResourceTarget,
  isOfficialHostedServer,
  registryServerAppKey,
  registryServerDomain,
  selectOfficialHostedServer,
  squireCallAppKeys,
} from './app-connections.js';

const remote = [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }];

describe('app identity', () => {
  it('reads a name, a website and an API URL as the same app', () => {
    expect(appIdentity('Linear')).toEqual({ key: 'linear' });
    expect(appIdentity('linear.app')).toEqual({ key: 'linear', domain: 'linear.app' });
    expect(appIdentity('https://api.linear.app/graphql')).toEqual({
      key: 'linear',
      domain: 'linear.app',
    });
    expect(appIdentity('Hugging Face')?.key).toBe(appIdentity('huggingface.co')?.key);
    expect(appIdentity('shop.example.co.uk')).toEqual({
      key: 'example',
      domain: 'example.co.uk',
    });
    expect(appIdentity('   ')).toBeUndefined();
    expect(appIdentity('!!!')).toBeUndefined();
    expect(appKeyForHost('127.0.0.1')).toBeUndefined();
  });

  it('names one grant target per app and keeps the route order fixed', () => {
    expect(appResourceTarget('linear')).toBe('app:linear');
    expect(APP_ROUTES).toEqual(['workbench', 'registry-mcp', 'squire-api', 'squire-browser']);
  });
});

describe('official hosted MCP servers', () => {
  it('reads the app from the verified Registry namespace only', () => {
    expect(registryServerAppKey('app.linear/linear')).toBe('linear');
    expect(registryServerAppKey('com.notion/mcp')).toBe('notion');
    expect(registryServerAppKey('io.github.github/github-mcp-server')).toBe('github');
    // A community package NAMED after the app is not the app's namespace.
    expect(registryServerAppKey('io.github.someone/linear')).toBe('someone');
    expect(registryServerAppKey('not a namespace/linear')).toBeUndefined();
    expect(registryServerDomain('com.stripe/mcp')).toBe('stripe.com');
    expect(registryServerDomain('io.github.github/github-mcp-server')).toBeUndefined();
  });

  it('accepts only the app’s own namespace with a streamable-http remote', () => {
    expect(isOfficialHostedServer({ name: 'app.linear/linear', version: '1', remotes: remote }, 'linear')).toBe(true);
    expect(
      isOfficialHostedServer({ name: 'io.github.someone/linear', version: '1', remotes: remote }, 'linear'),
    ).toBe(false);
    expect(
      isOfficialHostedServer(
        { name: 'app.linear/linear', version: '1', remotes: [{ type: 'sse', url: 'https://x' }] },
        'linear',
      ),
    ).toBe(false);
    expect(
      selectOfficialHostedServer(
        [
          { name: 'io.github.someone/linear', version: '9', remotes: remote },
          { name: 'app.linear/zeta', version: '1', remotes: remote },
          { name: 'app.linear/linear', version: '2', remotes: remote },
        ],
        'linear',
      )?.name,
    ).toBe('app.linear/linear');
  });
});

describe('Squire calls', () => {
  it('names the apps a call is for from its service and every URL it points at', () => {
    expect(
      squireCallAppKeys({
        reference: 'vault:opaque',
        http: { method: 'GET', url: 'https://api.linear.app/graphql' },
      }),
    ).toEqual(['linear']);
    expect(squireCallAppKeys({ service: 'Resend', url: 'https://resend.com/login' })).toEqual([
      'resend',
    ]);
    expect(squireCallAppKeys({ service: 'stripe', url: 'https://linear.app' })).toEqual([
      'linear',
      'stripe',
    ]);
    expect(squireCallAppKeys({})).toEqual([]);
    expect(squireCallAppKeys(undefined)).toEqual([]);
  });
});
