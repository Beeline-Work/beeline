import { describe, expect, it } from 'vitest';
import { projectSidebarPreview, readSidebarPreview } from './sidebar-preview.js';
const author = { pubkey: 'a'.repeat(64), kind: 'agent' as const, name: 'Agent' };
const message = { id: 'b'.repeat(64), createdAt: 1, author, presentation: 'message' as const,
  text: 'B'.repeat(128 * 1024) + '@viewer', mentionPubkeys: ['viewer'] };
describe('sidebar preview boundary', () => {
  it('bounds the message and deletion replacement independently, retaining resolved mentions', () => {
    const full = { type: 'message-delta' as const, roomId: 'room', message,
      deckPreview: { ...message, mentionsViewer: true as const } };
    const preview = projectSidebarPreview(full, 'viewer');
    expect(preview.preview.text).toHaveLength(240);
    expect(preview.preview.mentionsViewer).toBe(true);
    expect(preview.deckPreview?.text).toHaveLength(240);
    expect(readSidebarPreview(preview)).toEqual(preview);
    expect(full.message.text.length).toBeGreaterThan(128 * 1024);
    expect(preview).not.toHaveProperty('message');
  });
  it('rejects malformed or oversized previews rather than promoting them to full messages', () => {
    const preview = projectSidebarPreview({ type: 'message-delta', roomId: 'room', message }, 'viewer');
    expect(readSidebarPreview({ ...preview, preview: { ...preview.preview, text: 'X'.repeat(241) } })).toBeNull();
    expect(readSidebarPreview({ ...preview, preview: { ...preview.preview, author: { ...author, pubkey: 123 } } })).toBeNull();
    expect(readSidebarPreview({ ...preview, deckPreview: { ...preview.preview, createdAt: null } })).toBeNull();
    expect(readSidebarPreview({ ...preview, extra: 'X'.repeat(8193) })).toBeNull();
  });
});
