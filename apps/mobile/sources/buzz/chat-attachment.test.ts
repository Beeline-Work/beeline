import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-image-manipulator', () => ({
  manipulateAsync: vi.fn(),
  SaveFormat: { JPEG: 'jpeg' },
}));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: vi.fn() }));

import { formatAttachmentSize } from './chat-attachment';

describe('chat attachment display metadata', () => {
  it('formats bounded metadata without reading or displaying file content', () => {
    expect(formatAttachmentSize(900)).toBe('900 B');
    expect(formatAttachmentSize(1025)).toBe('2 KB');
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatAttachmentSize(20 * 1024 * 1024)).toBe('20 MB');
  });
});
