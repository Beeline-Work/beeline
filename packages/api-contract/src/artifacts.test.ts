import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_EXTENSIONS_BY_MIME,
  ARTIFACT_MAXIMUM_BYTES,
  ARTIFACT_MIME_BY_EXTENSION,
  ARTIFACT_MIME_TYPES,
  artifactSignatureMismatch,
  decodeArtifactTitleHeader,
  encodeArtifactTitleHeader,
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
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'audio/mpeg',
      'audio/wav',
      'audio/mp4',
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
      '.mp4': 'video/mp4',
      '.m4v': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
    });
    expect(ARTIFACT_EXTENSIONS_BY_MIME['application/octet-stream']).toEqual([]);
  });

  it('names the expected signature for a media mismatch and ignores other mimes', () => {
    const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    expect(artifactSignatureMismatch('video/mp4', mp4)).toBeUndefined();
    expect(artifactSignatureMismatch('audio/mp4', mp4)).toBeUndefined();
    expect(artifactSignatureMismatch('video/webm', mp4)).toBe(
      'a video/webm artifact must start with the EBML header 1A 45 DF A3; these bytes do not',
    );
    expect(artifactSignatureMismatch('audio/wav', new Uint8Array([1]))).toMatch(/RIFF\/WAVE/);
    expect(artifactSignatureMismatch('text/plain', new Uint8Array([1]))).toBeUndefined();
  });

  it('round-trips an em dash and a non-Latin title through the header codec', () => {
    for (const title of ['Release notes — v2', '設計メモ — リリース', 'Café ☕ 100%']) {
      const encoded = encodeArtifactTitleHeader(title);
      expect(encoded).toMatch(/^[\x20-\x7e]*$/);
      expect(decodeArtifactTitleHeader(encoded)).toBe(title);
    }
  });

  it('passes a plain ASCII title and a malformed escape through unchanged', () => {
    expect(decodeArtifactTitleHeader('Mock Page')).toBe('Mock Page');
    expect(decodeArtifactTitleHeader('100% done')).toBe('100% done');
  });
});
