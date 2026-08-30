import { describe, expect, it, vi } from 'vitest';
import { newUuid } from './uuid.js';

describe('newUuid', () => {
  it('uses RFC-4122 v4 fallback bytes when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0);
        return bytes;
      },
    });

    try {
      expect(newUuid()).toBe('00000000-0000-4000-8000-000000000000');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
