import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOOGLE_TOOL_SCOPES, installGoogleTool, outputTail } from './connector-google.js';
import type { GoogleWorkspaceClient } from './google-workspace-client.js';

const client = (ok = true) => ({
  verify: async () => ok
    ? { ok: true, account: 'dana@gmail.test' }
    : { ok: false, reason: 'Google refused the token' },
}) as GoogleWorkspaceClient;

function credentials(kind: string, granted = true) {
  return {
    source: 'beeline' as const,
    credentials: {
      accessToken: 'ya29.test', refreshToken: 'refresh.test',
      scopes: granted ? GOOGLE_TOOL_SCOPES[kind]! : [],
    },
  };
}

describe('Beeline Google install', () => {
  it('waits for the OAuth callback without marking the product failed', async () => {
    const result = await installGoogleTool({
      connectorType: 'google-gmail', home: '/tmp/unused', client: client(),
      resolveCredentials: async () => ({ source: 'pending', reason: 'waiting for Google sign-in' }),
    });
    expect(result.status).toBe('installing');
    expect(result.steps[1]).toMatchObject({ status: 'running', output: 'waiting for Google sign-in' });
  });

  it('connects a product with its own granted scopes and persists the helper copy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-google-'));
    const result = await installGoogleTool({
      connectorType: 'google-youtube', home, client: client(),
      resolveCredentials: async () => credentials('google-youtube'),
    });
    expect(result.status).toBe('connected');
    expect(result.signedInAs).toBe('dana@gmail.test');
    const stored = JSON.parse(readFileSync(join(home, 'google-credentials.json'), 'utf8'));
    expect(stored.scopes).toEqual(GOOGLE_TOOL_SCOPES['google-youtube']);
  });

  it('does not mount YouTube from a Gmail-only installation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-google-mail-'));
    const result = await installGoogleTool({
      connectorType: 'google-gmail', home, client: client(),
      resolveCredentials: async () => credentials('google-gmail'),
    });
    expect(result.status).toBe('connected');
    expect(existsSync(join(home, 'google-credentials.json'))).toBe(false);
  });

  it('fails only a product whose scopes were refused', async () => {
    const result = await installGoogleTool({
      connectorType: 'google-gmail', home: '/tmp/unused', client: client(),
      resolveCredentials: async () => credentials('google-gmail', false),
    });
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('google-gmail permission');
  });

  it('reports a Beeline grant read failure instead of waiting for consent forever', async () => {
    const result = await installGoogleTool({
      connectorType: 'google-drive', home: '/tmp/unused', client: client(),
      resolveCredentials: async () => ({ source: 'error', reason: 'Beeline grant unavailable' }),
    });
    expect(result.status).toBe('error');
    expect(result.steps[1]).toMatchObject({ status: 'failed', reason: 'Beeline grant unavailable' });
  });

  it('reports an invalid live token separately from scope refusal', async () => {
    const result = await installGoogleTool({
      connectorType: 'google-calendar', home: '/tmp/unused', client: client(false),
      resolveCredentials: async () => credentials('google-calendar'),
    });
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('Google refused');
  });

  it('keeps the requested scopes product-specific', () => {
    expect(GOOGLE_TOOL_SCOPES['google-youtube']).toEqual([
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
    ]);
  });
});

it('bounds progress output', () => {
  expect(outputTail('  short  ')).toBe('short');
  expect(outputTail('x'.repeat(900))).toHaveLength(801);
});
