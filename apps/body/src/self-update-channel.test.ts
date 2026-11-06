import { describe, expect, it, vi } from 'vitest';
import { ReleaseTransaction } from './managed-update.js';
import { DEFAULT_UPDATE_MANIFEST_URL, resolveManifestUrl } from './self-update-manifest.js';

describe('helper release channels', () => {
  it('keeps ordinary helpers and recovery on latest by default', () => {
    expect(resolveManifestUrl({})).toBe(DEFAULT_UPDATE_MANIFEST_URL);
    expect(resolveManifestUrl({ BEELINE_RELEASE_CHANNEL: 'latest' })).toBe(DEFAULT_UPDATE_MANIFEST_URL);
    expect(resolveManifestUrl({ BEELINE_RELEASE_CHANNEL: '  ' })).toBe(DEFAULT_UPDATE_MANIFEST_URL);
  });
  it('lets the squire opt into next', () => {
    expect(resolveManifestUrl({ BEELINE_RELEASE_CHANNEL: ' next ' }))
      .toBe('https://usebeeline.app/dl/next/manifest.json');
  });
  it('preserves explicit manifest overrides and rejects typos', () => {
    expect(resolveManifestUrl({ BEELINE_RELEASE_CHANNEL: 'next', BEELINE_UPDATE_MANIFEST_URL: ' https://lab.test/manifest.json ' }))
      .toBe('https://lab.test/manifest.json');
    expect(() => resolveManifestUrl({ BEELINE_RELEASE_CHANNEL: 'nightly' })).toThrow('invalid helper release channel');
    expect(() => resolveManifestUrl({ BEELINE_RELEASE_CHANNEL: 'nxet' })).toThrow('invalid helper release channel');
  });
});


it('rechecks a promoted channel even when the build identity was already announced by next', async () => {
  const prepare = vi.fn(async () => {});
  const update = new ReleaseTransaction({
    // No real install, network, native manager, or update worker participates.
    layout: { libDir: '/unavailable-beeline-test/lib', binDir: '/unavailable-beeline-test/bin', releasesRoot: '/unavailable-beeline-test/releases' },
    env: {}, prepare, idle: () => true, drain: vi.fn(), interrupt: vi.fn(),
    handoff: vi.fn(), changed: vi.fn(), failed: vi.fn(),
  });
  update.notify('v0.1.2:next-sha');
  await update.pending;
  update.notify('v0.1.2:next-sha');
  await update.pending;
  expect(prepare).toHaveBeenCalledTimes(2);
});
