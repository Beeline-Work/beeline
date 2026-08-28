import { describe, expect, it } from 'vitest';
import { previewAuthorLabel, roomPreviewText } from './room-list-summary';

describe('server Room-list presentation', () => {
  it('flattens readable markdown and drops fenced code', () => {
    expect(roomPreviewText('## Status\n- **done**: `npm test` passes')).toBe(
      'Status done: npm test passes',
    );
    expect(roomPreviewText('here is the fix\n```ts\nconst a = 1;\n```\nships tomorrow')).toBe(
      'here is the fix ships tomorrow',
    );
  });

  it('never shows raw git or tool plumbing', () => {
    for (const raw of [
      'fatal: could not read Username',
      '$ git push --force-with-lease',
      'refs/heads/main',
    ]) {
      expect(roomPreviewText(raw), raw).toBe('');
    }
  });

  it('bounds message and author presentation', () => {
    expect(roomPreviewText('x'.repeat(400))).toHaveLength(120);
    expect(previewAuthorLabel('Extraordinarily Long Name')).toBe('EXTRAORDINA…');
  });
});
