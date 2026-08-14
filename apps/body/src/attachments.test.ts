import { describe, expect, it } from 'vitest';
import {
  attachmentPathsFromText,
  attachmentPrompt,
  generatedImageCandidates,
  sanitizeActivityUpdate,
  stripAttachmentDirectives,
} from './attachments.js';

describe('Body attachment boundary', () => {
  it('projects inbound attachments as links and bounded metadata only', () => {
    const giantPayload = 'A'.repeat(2_000_000);
    const prompt = attachmentPrompt('f'.repeat(64), 'Review this', [
      {
        url: 'https://relay.example/media/large.pdf',
        name: 'large.pdf',
        mimeType: 'application/pdf',
        size: 24 * 1024 * 1024,
      },
    ]);
    expect(prompt).toContain('https://relay.example/media/large.pdf');
    expect(prompt).toContain('25165824 bytes');
    expect(prompt).not.toContain(giantPayload);
    expect(prompt.length).toBeLessThan(500);
  });

  it('attributes a Room participant by display name, handle, and stable key prefix', () => {
    expect(
      attachmentPrompt('f'.repeat(64), 'Mushroom works for me.', [], {
        kind: 'Agent',
        name: 'Joy',
        handle: 'joy',
      }),
    ).toBe('[Agent Joy (@joy) · ffffffffffff]: Mushroom works for me.');
  });

  it('extracts agent file directives and removes them from visible prose', () => {
    const text = 'Here it is. [[buzz-attachment:art/mushroom.png]] data:image/png;base64,ZmFrZQ==';
    expect(attachmentPathsFromText(text)).toEqual(['art/mushroom.png']);
    expect(stripAttachmentDirectives(text)).toBe('Here it is.\n[inline binary omitted]');
  });

  it('extracts generated ACP images while sanitizing the activity payload', () => {
    const data = Buffer.from('fake-png').toString('base64');
    const update = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'image-1',
        content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data } }],
      },
    };
    expect(generatedImageCandidates([update])).toEqual([
      expect.objectContaining({ name: 'generated-image-image-1.png', mimeType: 'image/png' }),
    ]);
    const sanitized = JSON.stringify(sanitizeActivityUpdate(update.update));
    expect(sanitized).not.toContain(data);
    expect(sanitized).toContain('binary omitted');
  });
});
