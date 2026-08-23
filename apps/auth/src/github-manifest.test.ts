import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appSetupEnvBlock,
  buildAppManifest,
  checkGitHubAppDriftBestEffort,
  convertAppManifestCode,
  formatGitHubAppDriftLine,
  gitHubAppDrift,
  REQUIRED_GITHUB_APP_EVENTS,
  REQUIRED_GITHUB_APP_PERMISSIONS,
} from './github-manifest.js';

const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAline1',
  'AQABline2',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

/** Real-shape POST /app-manifests/{code}/conversions payload (HTTP 201). */
const CONVERSION_PAYLOAD = {
  id: 1_234_567,
  node_id: 'MDM6QXBwMTIzNDU2Nw==',
  slug: 'beeline-test',
  owner: { login: 'octocat', type: 'User' },
  name: 'Beeline Test',
  description: 'test app',
  external_url: 'https://beeline.test',
  html_url: 'https://github.com/apps/beeline-test',
  created_at: '2026-08-23T00:00:00Z',
  updated_at: '2026-08-23T00:00:00Z',
  permissions: { metadata: 'read', contents: 'write' },
  events: ['star', 'issues', 'pull_request'],
  client_id: 'Iv1.abc123def456',
  client_secret: 'ghs_client_secret_value',
  webhook_secret: 'generated_webhook_secret_value',
  pem: PEM,
};

describe('GitHub App manifest flow', () => {
  it('preconfigures exactly the required events', () => {
    const manifest = buildAppManifest({
      name: 'Beeline',
      origin: 'https://usebeeline.app',
      redirectUrl: 'https://usebeeline.app/auth/github/app-setup?token=x',
    });
    expect(manifest.default_events).toEqual(['star', 'issues', 'pull_request']);
    expect(REQUIRED_GITHUB_APP_EVENTS).toEqual(['star', 'issues', 'pull_request']);
  });

  it('preconfigures exactly the required permission levels', () => {
    const manifest = buildAppManifest({
      name: 'Beeline',
      origin: 'https://usebeeline.app',
      redirectUrl: 'https://usebeeline.app/auth/github/app-setup?token=x',
    });
    expect(manifest.default_permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      issues: 'read',
      metadata: 'read',
      administration: 'write',
      checks: 'read',
      statuses: 'read',
      workflows: 'write',
    });
    expect(REQUIRED_GITHUB_APP_PERMISSIONS).toEqual(manifest.default_permissions);
  });

  it('points the webhook at the auth service with the redirect back to setup', () => {
    const manifest = buildAppManifest({
      name: 'Beeline',
      origin: 'https://usebeeline.app',
      redirectUrl: 'https://usebeeline.app/auth/github/app-setup?token=op-secret',
    });
    expect(manifest.hook_attributes).toEqual({
      url: 'https://usebeeline.app/auth/github/webhook',
      active: true,
    });
    expect(manifest.redirect_url).toBe(
      'https://usebeeline.app/auth/github/app-setup?token=op-secret',
    );
    expect(manifest.public).toBe(false);
  });

  it('exchanges the creation code for the full credential set', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(CONVERSION_PAYLOAD), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const conversion = await convertAppManifestCode('https://api.github.com', 'one-time-code');
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://api.github.com/app-manifests/one-time-code/conversions',
      );
      expect(conversion.appId).toBe(1_234_567);
      expect(conversion.slug).toBe('beeline-test');
      expect(conversion.pem).toBe(PEM);
      expect(conversion.clientId).toBe('Iv1.abc123def456');
      expect(conversion.clientSecret).toBe('ghs_client_secret_value');
      expect(conversion.webhookSecret).toBe('generated_webhook_secret_value');
      expect(conversion.htmlUrl).toBe('https://github.com/apps/beeline-test');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects an unusable or spent conversion code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })),
    );
    try {
      await expect(convertAppManifestCode('https://api.github.com', 'spent')).rejects.toThrow(
        /unknown or already used/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders the copy-paste env block with the private key newline-escaped', () => {
    const block = appSetupEnvBlock({
      appId: 1_234_567,
      slug: 'beeline-test',
      pem: PEM,
      clientId: 'Iv1.abc123def456',
      clientSecret: 'ghs_client_secret_value',
      webhookSecret: 'generated_webhook_secret_value',
    });
    const lines = block.trim().split('\n');
    expect(lines.map((line) => line.split('=')[0])).toEqual([
      'BEELINE_GITHUB_CLIENT_ID',
      'BEELINE_GITHUB_CLIENT_SECRET',
      'BEELINE_GITHUB_APP_ID',
      'BEELINE_GITHUB_APP_SLUG',
      'BEELINE_GITHUB_APP_PRIVATE_KEY',
      'BEELINE_GITHUB_WEBHOOK_SECRET',
    ]);
    // github.ts unescapes literal \n sequences; the block must carry exactly those.
    expect(lines[4]).toBe(`BEELINE_GITHUB_APP_PRIVATE_KEY=${PEM.replaceAll('\n', '\\n')}`);
  });
});

describe('GitHub App configuration drift', () => {
  const LIVE_OK = {
    slug: 'beeline',
    events: ['star', 'issues', 'pull_request'],
    permissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'read',
      metadata: 'read',
      administration: 'write',
      checks: 'read',
      statuses: 'read',
      workflows: 'write',
    },
  };

  it('passes when events and permissions match', () => {
    const drift = gitHubAppDrift(LIVE_OK);
    expect(drift).toEqual({ ok: true });
    expect(formatGitHubAppDriftLine(drift, LIVE_OK.slug)).toContain('match the required set');
  });

  it('names every missing event — the empty-events incident shape', () => {
    // The operator's hand-created app shipped exactly this: events absent entirely.
    const drift = gitHubAppDrift({ ...LIVE_OK, events: [] });
    expect(drift).toMatchObject({
      ok: false,
      missingEvents: ['star', 'issues', 'pull_request'],
      permissionProblems: [],
    });
    const line = formatGitHubAppDriftLine(drift, LIVE_OK.slug);
    expect(line).toContain("GitHub App configuration drift for 'beeline'");
    expect(line).toContain('star, issues, pull_request');
    expect(line).toContain('https://github.com/settings/apps/beeline/permissions');
  });

  it('names each permission below the required level', () => {
    const drift = gitHubAppDrift({
      ...LIVE_OK,
      permissions: { ...LIVE_OK.permissions, contents: 'read', workflows: undefined as never },
    });
    expect(drift).toMatchObject({
      ok: false,
      missingEvents: [],
      permissionProblems: [
        { key: 'contents', have: 'read', want: 'write' },
        { key: 'workflows', have: 'none', want: 'write' },
      ],
    });
    const line = formatGitHubAppDriftLine(drift, LIVE_OK.slug);
    expect(line).toContain('contents (read, need write)');
    expect(line).toContain('workflows (none, need write)');
  });

  it('is best-effort: a GitHub failure logs one line and never throws', async () => {
    const lines: string[] = [];
    const result = await checkGitHubAppDriftBestEffort(
      {
        fetchApp: async () => {
          throw new Error('GitHub app lookup failed: HTTP 502');
        },
      },
      (line) => lines.push(line),
    );
    expect(result).toBeUndefined();
    expect(lines).toEqual(['[auth] GitHub App drift check skipped: GitHub app lookup failed: HTTP 502']);
  });

  it('logs exactly one actionable line on drift and one on success', async () => {
    const lines: string[] = [];
    await checkGitHubAppDriftBestEffort(
      { fetchApp: async () => ({ ...LIVE_OK, events: [] }) },
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('not subscribed to events');
    lines.length = 0;
    await checkGitHubAppDriftBestEffort(
      { fetchApp: async () => LIVE_OK },
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('match the required set');
  });
});
