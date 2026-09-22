import { describe, expect, it } from 'vitest';
import { readCornerAppDefinition, readCornerAppManifest } from './corner-apps.js';

describe('Corner App definition', () => {
  const app = {
    version: 1,
    slug: 'release-board',
    title: 'Release board',
    description: 'The current release facts.',
    command: 'release-board',
    blocks: [
      { type: 'heading', text: 'Candidate' },
      { type: 'fields', items: [{ label: 'Version', value: '1.4.0' }] },
      { type: 'notice', tone: 'warning', text: 'Two checks remain.' },
      { type: 'action', label: 'Refresh facts', prompt: 'Refresh the release board.' },
    ],
  };

  it('accepts the bounded native vocabulary', () => {
    expect(readCornerAppDefinition(app)).toEqual(app);
  });

  it.each([
    { ...app, slug: '../release' },
    { ...app, command: '/release' },
    { ...app, version: 2 },
    { ...app, blocks: [{ type: 'html', text: '<script>alert(1)</script>' }] },
    { ...app, blocks: [{ type: 'action', label: 'Run', prompt: '' }] },
  ])('rejects executable or malformed definitions', (candidate) => {
    expect(readCornerAppDefinition(candidate)).toBeNull();
  });
});

describe('Corner App manifest', () => {
  const manifest = {
    version: 1,
    slug: 'release-board',
    title: 'Release board',
    developer: 'Example developer',
    humanUi: { kind: 'broker', capability: 'release-board.ui' },
    agent: { kind: 'broker', capability: 'release-board.agent' },
    permissions: ['github.read'],
  };

  it('keeps human UI and agent broker capabilities separate', () => {
    expect(readCornerAppManifest(manifest)).toEqual(manifest);
  });

  it('does not treat broker capability names as URLs or executable input', () => {
    expect(
      readCornerAppManifest({
        ...manifest,
        humanUi: { kind: 'broker', capability: 'https://example.com/app' },
      }),
    ).toBeNull();
  });
});
