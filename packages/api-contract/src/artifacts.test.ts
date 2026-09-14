import { describe, expect, it } from 'vitest';
import { ARTIFACT_MAXIMUM_BYTES, ARTIFACT_MIME_TYPES } from './artifacts.js';

describe('artifact contract constants', () => {
  it('caps artifacts at 2 MB and names the four plan mime types', () => {
    expect(ARTIFACT_MAXIMUM_BYTES).toBe(2 * 1024 * 1024);
    expect([...ARTIFACT_MIME_TYPES]).toEqual([
      'text/html',
      'image/svg+xml',
      'application/pdf',
      'text/markdown',
    ]);
  });
});
