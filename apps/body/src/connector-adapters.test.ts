import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualGoogleCredentialsSearchPaths } from './connector-google.js';
import {
  clearYoutubeGrant,
  isAdaptedSquire,
  isAdaptedYoutube,
} from './connector-adapters.js';

describe('helper connector adapters', () => {
  it('recognizes migrated Squire and YouTube kinds only', () => {
    expect(isAdaptedSquire('trusty-squire')).toBe(true);
    expect(isAdaptedYoutube('google-youtube')).toBe(true);
    expect(isAdaptedSquire('google-youtube')).toBe(false);
    expect(isAdaptedYoutube('trusty-squire')).toBe(false);
    expect(isAdaptedSquire('tailscale')).toBe(false);
    expect(isAdaptedYoutube('google-gmail')).toBe(false);
    expect(isAdaptedSquire(undefined)).toBe(false);
  });

  it('clears the YouTube grant file on adapter uninstall and ignores a missing file', () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-youtube-adapter-'));
    const path = manualGoogleCredentialsSearchPaths(home)[0]!;
    writeFileSync(path, '{"accessToken":"x"}');
    const notes: string[] = [];
    clearYoutubeGrant(home, (message) => notes.push(message));
    expect(existsSync(path)).toBe(false);
    expect(notes).toEqual([]);
    clearYoutubeGrant(home, (message) => notes.push(message));
    expect(notes).toEqual([]);
  });
});
