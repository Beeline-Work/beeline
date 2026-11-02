import { afterEach, expect, it, vi } from 'vitest';
import { GitHubAppClient } from './github.js';
afterEach(() => vi.unstubAllGlobals());
const app = () => new GitHubAppClient({ appId: '1', privateKey: 'unused', slug: 'fixture', apiBaseUrl: 'https://github.test' });
it('reads later pages and retains renamed/deleted prompt file names', async () => {
  const fetch = vi.fn(async (url: string) => Response.json(url.endsWith('page=1')
    ? Array.from({ length: 100 }, (_, i) => ({ filename: `other/${i}.ts` }))
    : [{ filename: 'new.md', previous_filename: 'docs/prompts/cases/old.json', status: 'renamed' }]));
  vi.stubGlobal('fetch', fetch);
  const result = await app().readPullRequestFiles('fixture', 'owner/repo', 7);
  expect(result.complete).toBe(true);
  expect(result.files).toHaveLength(101);
  expect(result.files[100]).toEqual({ filename: 'new.md', previousFilename: 'docs/prompts/cases/old.json' });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('marks the GitHub file cap incomplete instead of silently skipping a prompt change', async () => {
  const fetch = vi.fn(async () => Response.json(Array.from({ length: 100 }, (_, i) => ({ filename: `file${i}` }))));
  vi.stubGlobal('fetch', fetch);
  expect((await app().readPullRequestFiles('fixture', 'owner/repo', 7)).complete).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(30);
});
it('propagates a provider failure so the webhook can be retried', async () => {
  vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
  await expect(app().readPullRequestFiles('fixture', 'owner/repo', 7)).rejects.toThrow();
});
