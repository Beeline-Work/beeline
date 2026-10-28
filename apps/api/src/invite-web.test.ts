import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readRepositoryAssociations,
  validateRequiredAssociations,
} from '../../../scripts/app-associations.mjs';

import {
  APK_DOWNLOAD_URL,
  MONOLITH_ORIGIN,
  resolveInvitePreview,
  startInviteLanding,
} from '../../../web/join/invite-source.js';

const INVITE_TOKEN = 'inv_cd2f4ae16feb43b42a6566ce72ed437b38d374397b0769307c9bdcc29cfb2b38';

const repoFile = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('public invite website', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('publishes every production app-association dependency from the committed files', async () => {
    expect(validateRequiredAssociations(await readRepositoryAssociations())).toEqual([]);
  });

  it.each([`bzi_${'a'.repeat(64)}`, `bzi_${'A'.repeat(42)}_`])(
    'keeps an unexpired legacy invite link open in the static landing page',
    async (token) => {
      const page = invitePage(token);
      vi.stubGlobal('window', page.window);
      vi.stubGlobal('document', page.document);

      startInviteLanding({
        resolvePreview: vi.fn().mockResolvedValue(preview('Legacy Workspace')),
      });
      await vi.waitFor(() => expect(page.status.textContent).toBe('Signed invite verified.'));
      expect(page.join.href).toBe(`beeline://join/${token}`);
    },
  );

  it.each([
    ['?code=abc%2Fdef&scopes=user.info.basic,video.list&state=s%2B1', '?code=abc%2Fdef&scopes=user.info.basic,video.list&state=s%2B1'],
    ['?error=access_denied&redirect=https%3A%2F%2Fevil.test', '?error=access_denied&redirect=https%3A%2F%2Fevil.test'],
    ['', ''],
  ])('sends the Pages TikTok callback %j to the fixed Composio callback', (search, carried) => {
    const page = repoFile('web/oauth/tiktok/callback/index.html');
    expect(page).toContain('<meta name="referrer" content="no-referrer" />');
    expect(page).toContain('<meta name="robots" content="noindex, nofollow" />');
    const script = page.match(/<script>\n([\s\S]*?)\n    <\/script>/)?.[1];
    expect(script).toBeDefined();
    const replace = vi.fn();
    const location = { search, href: `https://evil.test/oauth/tiktok/callback/${search}`,
      origin: 'https://evil.test', pathname: '/oauth/tiktok/callback/', hash: '#https://evil.test', replace };
    Function('location', script!)(location);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`https://backend.composio.dev/api/v3/toolkits/auth/callback${carried}`);
  });

  it('renders one monochrome join action without exposing the invite token', () => {
    const landing = repoFile('web/join/index.html');
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

  it('resolves the public preview from the monolith through the server API', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input: String(input), init });
        return Response.json(preview('Test workspace 1'));
      }),
    );

    await expect(resolveInvitePreview(MONOLITH_ORIGIN, INVITE_TOKEN)).resolves.toEqual(
      preview('Test workspace 1'),
    );

    expect(requests).toEqual([
      {
        input: `${MONOLITH_ORIGIN}/v1/public/invite-preview?token=${INVITE_TOKEN}`,
        init: { headers: { accept: 'application/json' } },
      },
    ]);
    const source = repoFile('web/join/invite-source.js');
    expect(source).not.toContain('/query');
    expect(source).not.toContain('createIdentity');
    expect(source).not.toContain('Nostr');
  });

  it('times out failed invite resolution and lets the visitor retry', async () => {
    vi.useFakeTimers();
    const page = invitePage();
    vi.stubGlobal('window', page.window);
    vi.stubGlobal('document', page.document);
    const resolvePreview = vi
      .fn<() => Promise<ReturnType<typeof preview>>>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(preview('Retry Workspace'));

    startInviteLanding({ resolvePreview, resolveTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);

    expect(page.status.textContent).toBe(
      "Couldn't reach the Workspace. Check your connection and retry.",
    );
    expect(page.join.textContent).toBe('Retry');

    page.join.onclick?.({ preventDefault: vi.fn() });
    await vi.runAllTimersAsync();

    expect(resolvePreview).toHaveBeenCalledTimes(2);
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
      resolvePreview: vi.fn().mockResolvedValue(preview('New Friends')),
      openApp,
      appOpenTimeoutMs: 50,
    });
    await vi.runAllTimersAsync();
    page.join.onclick?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(50);

    expect(openApp).toHaveBeenCalledWith(
      'beeline://join/inv_cd2f4ae16feb43b42a6566ce72ed437b38d374397b0769307c9bdcc29cfb2b38',
    );
    expect(page.join.textContent).toBe('Get Beeline');
    expect(page.join.href).toBe(APK_DOWNLOAD_URL);
    expect(page.details.textContent).toContain('then return to this invite');

    page.join.onclick?.({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);

    expect(page.join.textContent).toBe('Open Beeline and join');
    expect(page.join.href).toContain('beeline://join/inv_');
  });

  it('keeps the checked-in browser bundle in sync with its source', () => {
    const output = buildSync({
      absWorkingDir: new URL('../../..', import.meta.url).pathname,
      bundle: true,
      entryPoints: ['web/join/invite-source.js'],
      format: 'iife',
      minify: true,
      platform: 'browser',
      target: ['es2022'],
      write: false,
    }).outputFiles[0]?.text;

    expect(repoFile('web/join/invite.js')).toBe(output);
  });
});

function invitePage(token = INVITE_TOKEN) {
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
      pathname: `/join/${token}`,
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

function preview(workspaceName: string) {
  return {
    valid: true as const,
    workspaceName,
    inviterName: 'Alex',
    expiresAt: 2_000_000_000,
  };
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
