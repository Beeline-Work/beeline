import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KIND_COMMUNITY_INVITE,
  KIND_CREATE_GROUP,
  TAG_COMMUNITY,
  TAG_COMMUNITY_INVITE,
  createIdentity,
  inviteTokenHash,
} from '@beeline/buzz-client';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';

import {
  APK_DOWNLOAD_URL,
  resolveWorkspaceName,
  startInviteLanding,
} from '../../../relay-stack/web/join/invite-source.js';

const INVITE_TOKEN = 'bzi_cd2f4ae16feb43b42a6566ce72ed437b38d374397b0769307c9bdcc29cfb2b38';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('relay invite web front', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('publishes the production app associations', () => {
    const apple = JSON.parse(repoFile('relay-stack/web/.well-known/apple-app-site-association'));
    const android = JSON.parse(repoFile('relay-stack/web/.well-known/assetlinks.json'));

    expect(apple).toEqual({
      applinks: {
        apps: [],
        details: [
          {
            appID: '89KT3SWYAF.app.usebeeline.mobile',
            paths: ['/join/*', '/auth/github/mobile-callback', '/auth/oidc/mobile-callback'],
          },
        ],
      },
    });
    expect(android).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'app.usebeeline.mobile',
          sha256_cert_fingerprints: [
            'F1:0A:CD:08:4A:67:32:53:9D:3C:72:27:9C:8D:64:97:EB:3F:3A:3D:C4:EB:FF:74:F9:6C:57:76:D9:99:72:18',
          ],
        },
      },
    ]);
  });

  it('serves only valid invite paths and proxies the relay including upgrades', () => {
    const nginx = repoFile('relay-stack/nginx.conf');
    const compose = repoFile('relay-stack/compose.yml');
    const landing = repoFile('relay-stack/web/join/index.html');
    const script = repoFile('relay-stack/web/join/invite.js');

    expect(nginx).toContain('^/join/bzi_[0-9a-f]{64}/?$');
    expect(nginx).toContain('location = /join/invite.js');
    expect(nginx).toContain('proxy_pass http://relay:3000');
    expect(nginx).toContain('proxy_set_header Upgrade $http_upgrade');
    expect(nginx).toContain("img-src 'self' data:");
    expect(compose).toContain('${BUZZ_HTTP_PORT:-3010}:3000');
    expect(compose).toContain('./web:/usr/share/nginx/html:ro');
    expect(compose).toContain('"host":"usebeeline.app"');
    expect(compose).toContain('"host":"relay.buzzrouter.com"');
    expect(landing).toContain("You're invited to a Workspace");
    expect(landing).toContain('rel="icon"');
    expect(landing).toContain('data:image/svg+xml');
    expect(script).toContain('beeline://join/');
  });

  it('renders one monochrome join action without exposing the invite token', () => {
    const landing = repoFile('relay-stack/web/join/index.html');
    const colors = [...landing.matchAll(/#[0-9a-f]{6}/gi)].map(([color]) => color);

    expect(landing.match(/<(?:a|button)\b/gi)).toHaveLength(1);
    expect(landing).toContain('id="join-workspace"');
    expect(landing).toContain('Resolving invite…');
    expect(landing).toContain('If Beeline is not installed');
    expect(landing).not.toContain('Copy invite code');
    expect(landing).not.toContain('id="invite-code"');
    expect(colors.length).toBeGreaterThan(0);
    expect(
      colors.every((color) => {
        const [, red, green, blue] = color.match(/^#(..)(..)(..)$/i) ?? [];
        return red === green && green === blue;
      }),
    ).toBe(true);
  });

  it('resolves an invite anonymously with an ephemeral NIP-98 identity', async () => {
    const inviter = createIdentity('invite-web-test-owner');
    const communityId = '49af6fcb-cd8e-4e07-8cfe-462d58185386';
    const createdAt = Math.floor(Date.now() / 1000);
    const invite = signEvent(
      {
        pubkey: inviter.publicKey,
        created_at: createdAt,
        kind: KIND_COMMUNITY_INVITE,
        tags: [
          ['d', inviteTokenHash(INVITE_TOKEN)],
          ['h', communityId],
          [TAG_COMMUNITY, communityId],
          ['t', TAG_COMMUNITY_INVITE],
          ['expiration', String(createdAt + 3_600)],
        ],
        content: '',
      },
      inviter.secretKey,
    );
    const workspace = signEvent(
      {
        pubkey: inviter.publicKey,
        created_at: createdAt,
        kind: KIND_CREATE_GROUP,
        tags: [
          ['h', communityId],
          ['name', 'Test workspace 1'],
          [TAG_COMMUNITY, communityId],
        ],
        content: '',
      },
      inviter.secretKey,
    );
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input: String(input), init });
        const filters = JSON.parse(String(init?.body)) as Array<{ kinds?: number[] }>;
        const events = filters.some((filter) => filter.kinds?.includes(KIND_COMMUNITY_INVITE))
          ? [invite]
          : filters.some((filter) => filter.kinds?.includes(KIND_CREATE_GROUP))
            ? [workspace]
            : [];
        return new Response(JSON.stringify(events), { status: 200 });
      }),
    );

    await expect(resolveWorkspaceName('https://usebeeline.app', INVITE_TOKEN)).resolves.toBe(
      'Test workspace 1',
    );

    expect(requests).toHaveLength(2);
    const ephemeralPubkeys = requests.map(({ input, init }) => {
      const headers = init?.headers as Record<string, string>;
      const auth = decodeNip98Auth(headers.authorization);
      expect(input).toBe('https://usebeeline.app/query');
      expect(headers.authorization).toMatch(/^Nostr /);
      expect(headers['x-pubkey']).toBe(auth.pubkey);
      expect(auth.pubkey).not.toBe(inviter.publicKey);
      expect(auth.tags).toContainEqual(['u', input]);
      expect(auth.tags).toContainEqual(['method', 'POST']);
      expect(verifyEvent(auth)).toBe(true);
      return auth.pubkey;
    });
    expect(new Set(ephemeralPubkeys).size).toBe(1);
  });

  it('times out failed invite resolution and lets the visitor retry', async () => {
    vi.useFakeTimers();
    const page = invitePage();
    vi.stubGlobal('window', page.window);
    vi.stubGlobal('document', page.document);
    const resolveWorkspace = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce('Retry Workspace');

    startInviteLanding({ resolveWorkspace, resolveTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);

    expect(page.status.textContent).toBe(
      "Couldn't reach the Workspace. Check your connection and retry.",
    );
    expect(page.join.textContent).toBe('Retry');

    page.join.onclick?.({ preventDefault: vi.fn() });
    await vi.runAllTimersAsync();

    expect(resolveWorkspace).toHaveBeenCalledTimes(2);
    expect(page.join.textContent).toBe('Join Retry Workspace');
    expect(page.status.textContent).toBe('Signed invite verified.');
  });

  it('offers the APK while preserving the invite when the app does not open', async () => {
    vi.useFakeTimers();
    const page = invitePage();
    vi.stubGlobal('window', page.window);
    vi.stubGlobal('document', page.document);
    const openApp = vi.fn();

    startInviteLanding({
      resolveWorkspace: vi.fn().mockResolvedValue('New Friends'),
      openApp,
      appOpenTimeoutMs: 50,
    });
    await vi.runAllTimersAsync();
    page.join.onclick?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(50);

    expect(openApp).toHaveBeenCalledWith(
      'beeline://join/bzi_cd2f4ae16feb43b42a6566ce72ed437b38d374397b0769307c9bdcc29cfb2b38',
    );
    expect(page.join.textContent).toBe('Get Beeline');
    expect(page.join.href).toBe(APK_DOWNLOAD_URL);
    expect(page.details.textContent).toContain('then return to this invite');

    page.join.onclick?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);

    expect(page.join.textContent).toBe('Open Beeline and join');
    expect(page.join.href).toContain('beeline://join/bzi_');
  });

  it('keeps the checked-in browser bundle in sync with its source', () => {
    const output = buildSync({
      absWorkingDir: new URL('../../..', import.meta.url).pathname,
      bundle: true,
      entryPoints: ['relay-stack/web/join/invite-source.js'],
      format: 'iife',
      minify: true,
      platform: 'browser',
      target: ['es2022'],
      alias: {
        '@beeline/buzz-client': './packages/buzz-client/src/index.ts',
        '@beeline/nostr': './packages/nostr/src/index.ts',
      },
      write: false,
    }).outputFiles[0]?.text;

    expect(repoFile('relay-stack/web/join/invite.js')).toBe(output);
  });
});

function invitePage() {
  const elements = {
    '#join-workspace': fakeElement(),
    '#invite-heading': fakeElement(),
    '#invite-details': fakeElement(),
    '#status': fakeElement(),
  };
  const listeners = new Map<string, () => void>();
  const document = {
    hidden: false,
    title: '',
    querySelector: (selector: keyof typeof elements) => elements[selector],
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const window = {
    location: {
      pathname: `/join/${INVITE_TOKEN}`,
      origin: 'https://usebeeline.app',
      assign: vi.fn(),
    },
    setTimeout,
    clearTimeout,
  };

  return {
    document,
    window,
    join: elements['#join-workspace'],
    details: elements['#invite-details'],
    status: elements['#status'],
  };
}

function decodeNip98Auth(value: string): NostrEvent {
  const encoded = value.slice('Nostr '.length);
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
  );
  return JSON.parse(json) as NostrEvent;
}

function fakeElement() {
  const attributes = new Map<string, string>();
  return {
    textContent: '',
    href: '',
    onclick: undefined as ((event: { preventDefault: () => void }) => void) | undefined,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
      if (name === 'href') this.href = '';
    },
  };
}
