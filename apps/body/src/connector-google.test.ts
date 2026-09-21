import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConnectorStep } from '@beeline/api-contract/daemon';
import type { SquireMcpClient } from './connector-squire.js';
import { GOOGLE_TOOL_SCOPES, installGoogleTool, outputTail } from './connector-google.js';
import type { GoogleWorkspaceClient } from './google-workspace-client.js';

function fakeSquire(call: (tool: string, args: unknown) => unknown): SquireMcpClient {
  return { call } as unknown as SquireMcpClient;
}

const fakeClient = (verify: { ok: true; account?: string } | { ok: false; reason: string }) =>
  ({ verify: async () => verify }) as unknown as GoogleWorkspaceClient;

const okClient = fakeClient({ ok: true, account: 'dana@gmail.test' });

describe('installGoogleTool', () => {
  it('connects one-click through the Squire vault and reports every step', async () => {
    const progress: readonly ConnectorStep[][] = [];
    const squire = fakeSquire(() => ({
      credentials: {
        accessToken: 'ya29.one-click',
        accountEmail: 'dana@gmail.test',
      },
    }));
    const result = await installGoogleTool({
      connectorType: 'google-gmail',
      home: '/tmp/home',
      squire,
      client: okClient,
      onProgress: (steps) => progress.push(steps),
    });
    expect(result.status).toBe('connected');
    expect(result.signedInAs).toBe('dana@gmail.test');
    expect(result.steps.map((step) => [step.label, step.status])).toEqual([
      ['helper reached', 'done'],
      ['Google credentials resolved', 'done'],
      ['authorized with Google', 'done'],
      ['tools enabled', 'done'],
    ]);
    expect(result.steps[1]!.output).toContain('one-click');
    // Every transition streamed to the phone while it settled.
    expect(progress.length).toBe(6);
    expect(progress.at(-1)!.length).toBe(4);
  });

  it('falls back to the manual path when Squire has no Google grant yet', async () => {
    const squire = fakeSquire(() => {
      throw new Error('tool not found: google_oauth_credentials');
    });
    const result = await installGoogleTool({
      connectorType: 'google-drive',
      home: '/tmp/home',
      squire,
      client: okClient,
      resolveCredentials: async () => ({
        source: 'manual',
        credentials: { accessToken: 'ya29.manual' },
      }),
    });
    expect(result.status).toBe('connected');
    expect(result.steps[1]!.output).toContain('manual');
  });

  it('fails at the credentials step with the honest reason when nothing resolves', async () => {
    const result = await installGoogleTool({
      connectorType: 'google-calendar',
      home: '/tmp/home',
      resolveCredentials: async () => ({
        source: 'unavailable',
        reason: 'no Trusty Squire connector is paired',
      }),
      client: okClient,
    });
    expect(result.status).toBe('error');
    const failed = result.steps.find((step) => step.status === 'failed')!;
    expect(failed.label).toBe('Google credentials resolved');
    expect(failed.reason).toContain('no Trusty Squire');
    // The failed step carries the reason; nothing after it settled.
    expect(result.steps.at(-1)!.status).toBe('failed');
    expect(result.steps.at(-1)!.reason).toContain('no Trusty Squire');
    expect(result.steps.filter((step) => step.status === 'failed')).toHaveLength(1);
  });

  it('fails at the authorization step when Google refuses the grant', async () => {
    const result = await installGoogleTool({
      connectorType: 'google-youtube',
      home: '/tmp/home',
      resolveCredentials: async () => ({
        source: 'manual',
        credentials: { accessToken: 'ya29.stale' },
      }),
      client: fakeClient({ ok: false, reason: 'access token rejected by Google' }),
    });
    expect(result.status).toBe('error');
    expect(result.steps.at(-1)!.label).toBe('authorized with Google');
    expect(result.steps.at(-1)!.status).toBe('failed');
    expect(result.errorMessage).toContain('access token rejected');
  });

  it('prefers the shared resolvedCredentials over its own resolution', async () => {
    const squire = fakeSquire(() => {
      throw new Error('must not consult Squire when credentials arrive resolved');
    });
    const result = await installGoogleTool({
      connectorType: 'google-gmail',
      home: '/tmp/home',
      squire,
      client: okClient,
      resolvedCredentials: Promise.resolve({
        source: 'manual',
        credentials: { accessToken: 'ya29.shared' },
      }),
    });
    expect(result.status).toBe('connected');
    expect(result.steps[1]!.output).toContain('manual');
  });

  it('refuses a non-Google connector type', async () => {
    const result = await installGoogleTool({
      connectorType: 'trusty-squire',
      home: '/tmp/home',
      client: okClient,
    });
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('not a Google tool connector');
  });

  it('falls through to the manual path when Squire refuses, never presenting its error as Google’s own', async () => {
    const squire = fakeSquire(() => {
      throw new Error(
        'another Trusty Squire session is already using the browser — close it first',
      );
    });
    const home = mkdtempSync(join(tmpdir(), 'beeline-google-refused-'));
    const result = await installGoogleTool({
      connectorType: 'google-gmail',
      home,
      squire,
      client: okClient,
    });
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('no Google credentials found');
    expect(result.errorMessage).not.toMatch(/already using the browser/i);
  });
});

describe('YouTube Google scopes', () => {
  it('asks for Data API read plus Analytics, never upload', () => {
    expect(GOOGLE_TOOL_SCOPES['google-youtube']).toEqual([
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
    ]);
  });
});

describe('installGoogleTool persistence', () => {
  it('writes the resolved grant onto the helper so YouTube can mount later', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-google-'));
    const result = await installGoogleTool({
      connectorType: 'google-youtube',
      home,
      client: okClient,
      resolveCredentials: async () => ({
        source: 'squire',
        credentials: { accessToken: 'ya29.persist', accountEmail: 'dana@gmail.test' },
      }),
    });
    expect(result.status).toBe('connected');
    const stored = JSON.parse(readFileSync(join(home, 'google-credentials.json'), 'utf8')) as {
      accessToken: string;
    };
    expect(stored.accessToken).toBe('ya29.persist');
  });
});

describe('outputTail', () => {
  it('keeps short output whole and truncates long output to its tail', () => {
    expect(outputTail('  short  ')).toBe('short');
    const long = 'x'.repeat(900);
    const tail = outputTail(long);
    expect(tail.length).toBe(801);
    expect(tail.startsWith('…')).toBe(true);
  });
});
