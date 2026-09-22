import { describe, expect, it } from 'vitest';
import { readCornerAppDefinition } from './corner-apps.js';

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
