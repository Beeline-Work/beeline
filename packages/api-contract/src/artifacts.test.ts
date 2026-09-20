import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_EXTENSIONS_BY_MIME,
  ARTIFACT_MAXIMUM_BYTES,
  ARTIFACT_MIME_BY_EXTENSION,
  ARTIFACT_MIME_TYPES,
} from './artifacts.js';

describe('artifact contract constants', () => {
  it('caps artifacts at 25 MB and inventories every accepted mime type', () => {
    expect(ARTIFACT_MAXIMUM_BYTES).toBe(25 * 1024 * 1024);
    expect([...ARTIFACT_MIME_TYPES]).toEqual([
      'text/html',
      'image/svg+xml',
      'application/pdf',
      'text/markdown',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'text/plain',
      'application/json',
      'text/csv',
      'application/zip',
      'application/octet-stream',
    ]);
  });

  it('accounts for extension inference for every accepted mime', () => {
    expect(Object.keys(ARTIFACT_EXTENSIONS_BY_MIME)).toEqual([...ARTIFACT_MIME_TYPES]);
    expect(ARTIFACT_MIME_BY_EXTENSION).toEqual({
      '.html': 'text/html',
      '.htm': 'text/html',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.md': 'text/markdown',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.txt': 'text/plain',
      '.log': 'text/plain',
      '.json': 'application/json',
      '.csv': 'text/csv',
      '.zip': 'application/zip',
    });
    expect(ARTIFACT_EXTENSIONS_BY_MIME['application/octet-stream']).toEqual([]);
  });
});
