import { describe, expect, it } from 'vitest';
import { speechLocaleFromDeviceLocales } from './speech-locale';

describe('speech recognition locale', () => {
  it('uses the first complete device language tag', () => {
    expect(
      speechLocaleFromDeviceLocales([{ languageTag: 'fr-CA' }, { languageTag: 'en-US' }]),
    ).toBe('fr-CA');
  });

  it('skips empty tags and falls back safely', () => {
    expect(speechLocaleFromDeviceLocales([{ languageTag: ' ' }, { languageTag: 'ja-JP' }])).toBe(
      'ja-JP',
    );
    expect(speechLocaleFromDeviceLocales([])).toBe('en-US');
  });
});
