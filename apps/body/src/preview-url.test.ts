import { describe, expect, it, vi } from 'vitest';
import {
  parseGitHubRemote,
  resolvePreviewUrl,
  selectPreviewCheckRunUrl,
  selectPreviewStatusUrl,
} from './preview-url.js';

const tip = 'a'.repeat(40);

describe('parseGitHubRemote', () => {
  it('reads owner/repo out of every usual remote spelling', () => {
    for (const remote of [
      'https://github.com/lunchboxfortwo/beeline.git',
      'https://github.com/lunchboxfortwo/beeline',
      'git@github.com:lunchboxfortwo/beeline.git',
      'ssh://git@github.com/lunchboxfortwo/beeline',
      'git://github.com/lunchboxfortwo/beeline',
      'https://x-access-token:tok@github.com/lunchboxfortwo/beeline.git',
    ]) {
      expect(parseGitHubRemote(remote), remote).toEqual({
        owner: 'lunchboxfortwo',
        repo: 'beeline',
      });
    }
  });

  it('is null for a non-GitHub or empty remote', () => {
    expect(parseGitHubRemote('https://usebeeline.app/git/abc/repo')).toBeNull();
    expect(parseGitHubRemote('/srv/repos/local.git')).toBeNull();
    expect(parseGitHubRemote(undefined)).toBeNull();
  });
});

describe('selecting a preview URL from commit signals', () => {
  it('takes a preview deployment status and ignores an ordinary CI status', () => {
    expect(
      selectPreviewStatusUrl([
        { context: 'ci/tests', state: 'success', target_url: 'https://ci.example/run/1' },
        {
          context: 'vercel',
          state: 'success',
          description: 'Deployment has completed',
          target_url: 'https://beeline-git-feature.vercel.app',
        },
      ]),
    ).toBe('https://beeline-git-feature.vercel.app');
  });

  it('renders nothing when there are no statuses, or only CI ones', () => {
    expect(selectPreviewStatusUrl(undefined)).toBeUndefined();
    expect(selectPreviewStatusUrl([])).toBeUndefined();
    expect(
      selectPreviewStatusUrl([
        { context: 'ci/tests', state: 'success', target_url: 'https://ci.example/run/1' },
      ]),
    ).toBeUndefined();
  });

  it('refuses a failed preview and a non-https URL', () => {
    expect(
      selectPreviewStatusUrl([
        { context: 'netlify/deploy-preview', state: 'failure', target_url: 'https://x.netlify.app' },
      ]),
    ).toBeUndefined();
    expect(
      selectPreviewStatusUrl([
        { context: 'netlify/deploy-preview', state: 'success', target_url: 'javascript:alert(1)' },
      ]),
    ).toBeUndefined();
  });

  it('falls back to a check run that names a preview', () => {
    expect(
      selectPreviewCheckRunUrl([
        { name: 'build', conclusion: 'success', details_url: 'https://gh/checks/1' },
        {
          name: 'Cloudflare Pages preview',
          conclusion: 'success',
          details_url: 'https://abc.pages.dev',
        },
      ]),
    ).toBe('https://abc.pages.dev');
  });
});

describe('resolvePreviewUrl', () => {
  it('returns the status URL for a GitHub remote', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          statuses: [
            {
              context: 'vercel — preview',
              state: 'success',
              target_url: 'https://preview.example.app',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    await expect(
      resolvePreviewUrl({ remote: 'https://github.com/o/r.git', tip, fetchImpl }),
    ).resolves.toBe('https://preview.example.app');
  });

  it('is undefined — never a throw — for a non-GitHub remote, a bad tip, or a failing API', async () => {
    const boom = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(
      resolvePreviewUrl({ remote: 'https://usebeeline.app/git/o/r', tip, fetchImpl: boom }),
    ).resolves.toBeUndefined();
    await expect(
      resolvePreviewUrl({ remote: 'https://github.com/o/r', tip: 'not-a-tip', fetchImpl: boom }),
    ).resolves.toBeUndefined();
    await expect(
      resolvePreviewUrl({ remote: 'https://github.com/o/r', tip, fetchImpl: boom }),
    ).resolves.toBeUndefined();
  });

  it('is undefined when the commit simply has no statuses or checks', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      new Response(
        JSON.stringify(String(input).endsWith('/status') ? { statuses: [] } : { check_runs: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    await expect(
      resolvePreviewUrl({ remote: 'git@github.com:o/r.git', tip, fetchImpl }),
    ).resolves.toBeUndefined();
  });
});
